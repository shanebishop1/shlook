import {
  assertConnectionCredentialStorageSupported,
  decodeConnectionCredential,
  persistConnectionCredential,
  type ConnectionCredential,
} from "../cli-connection.ts";

import { authenticatedFetch } from "./http.ts";
import { AuthenticatedRedirectError, CliError } from "./errors.ts";
import { defaultOrigins, origins } from "./origins.ts";
import type { ConnectionTokenInput, ConnectionTokenPrompt, CliDependencies } from "./types.ts";
import {
  effectiveTokenEnv,
  loadProfileConfig,
  saveNamedCredential,
  saveProfileConfig,
  validateProfileConfig,
  normalizedTokenEnv,
  type InstanceProfile,
} from "./profiles.ts";

const maximumConnectionTokenBytes = 20_000;
const maximumConnectionHealthBytes = 1_024;

function inputError(value: unknown): Error {
  return value instanceof Error ? value : new Error("connection credential input failed");
}

export function readConnectionToken(
  input: ConnectionTokenInput,
  prompt: ConnectionTokenPrompt,
): Promise<string> {
  const interactive = input.isTTY === true;
  const initiallyPaused = input.isPaused();
  const initiallyRaw = input.isRaw === true;

  return new Promise((resolve, reject) => {
    let value = "";
    let valueBytes = 0;
    let settled = false;
    let rawModeTouched = false;

    const onData = (chunk: string | Uint8Array) => {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      if (!interactive) {
        value += text;
        valueBytes += Buffer.byteLength(text);
        if (valueBytes > maximumConnectionTokenBytes)
          settle(new Error("connection credential input is invalid"));
        return;
      }

      for (const character of text) {
        if (character === "\u0003") {
          settle(new Error("connection credential input cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\b" || character === "\u007f") {
          const previous = Array.from(value).at(-1);
          if (previous !== undefined) {
            value = value.slice(0, -previous.length);
            valueBytes -= Buffer.byteLength(previous);
          }
          continue;
        }
        value += character;
        valueBytes += Buffer.byteLength(character);
        if (valueBytes > maximumConnectionTokenBytes) {
          settle(new Error("connection credential input is invalid"));
          return;
        }
      }
    };
    const onEnd = () => finish();
    const onError = (error: unknown) => settle(inputError(error));

    const cleanup = (): Error | undefined => {
      let cleanupError: Error | undefined;
      const attempt = (operation: () => unknown) => {
        try {
          operation();
        } catch (cause) {
          cleanupError ??= inputError(cause);
        }
      };
      attempt(() => input.removeListener("data", onData));
      attempt(() => input.removeListener("end", onEnd));
      attempt(() => input.removeListener("error", onError));
      if (interactive && rawModeTouched) attempt(() => input.setRawMode?.(initiallyRaw));
      if (initiallyPaused) attempt(() => input.pause());
      return cleanupError;
    };

    function settle(error?: Error): void {
      if (settled) return;
      settled = true;
      const cleanupError = cleanup();
      if (interactive) {
        try {
          prompt.write("\n");
        } catch (cause) {
          if (error === undefined) error = inputError(cause);
        }
      }
      error ??= cleanupError;
      if (error === undefined) resolve(value.trim());
      else reject(error);
    }

    function finish(): void {
      if (value.trim() === "") settle(new Error("connection credential input is required"));
      else settle();
    }

    try {
      input.on("data", onData);
      input.on("end", onEnd);
      input.on("error", onError);
      if (interactive) {
        if (input.setRawMode === undefined)
          throw new Error("connection credential input is unavailable");
        rawModeTouched = true;
        input.setRawMode(true);
      }
      input.resume();
      if (interactive) prompt.write("Connection token: ");
    } catch (cause) {
      settle(inputError(cause));
    }
  });
}

async function verifyConnectionHealth(response: Response): Promise<void> {
  try {
    const contentType = (response.headers.get("content-type") ?? "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (response.status === 204 || contentType !== "application/json" || response.body === null) {
      throw new Error("invalid health response");
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maximumConnectionHealthBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error("health response is too large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("invalid health response");
    const keys = Object.keys(value);
    const ok = Object.getOwnPropertyDescriptor(value, "ok");
    const service = Object.getOwnPropertyDescriptor(value, "service");
    if (
      keys.length !== 2 ||
      !keys.includes("ok") ||
      !keys.includes("service") ||
      ok === undefined ||
      !("value" in ok) ||
      ok.value !== true ||
      service === undefined ||
      !("value" in service) ||
      service.value !== "shlook"
    )
      throw new Error("invalid health response");
  } catch {
    throw new CliError("connection_verification_failed", "connection verification failed");
  }
}

export async function connect(
  dependencies: CliDependencies,
  args: string[],
  fromEnvironment = false,
): Promise<{ domain: string; path: string; connected: true }> {
  if (args.length !== 0) {
    throw new CliError("usage_error", "connect reads its credential from standard input");
  }
  try {
    assertConnectionCredentialStorageSupported({ currentUid: dependencies.currentUid });
  } catch {
    throw new CliError(
      "connection_persistence_failed",
      "local connection credential storage is unavailable",
    );
  }

  let credential: ConnectionCredential;
  if (fromEnvironment) {
    const accessClientId = dependencies.env.CF_ACCESS_CLIENT_ID;
    const accessClientSecret = dependencies.env.CF_ACCESS_CLIENT_SECRET;
    if (accessClientId === undefined || accessClientSecret === undefined) {
      throw new CliError(
        "auth_required",
        "CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are required",
      );
    }
    const configured = origins(dependencies);
    credential = {
      domain: dependencies.env.SHLOOK_DOMAIN ?? new URL(configured.owner).hostname,
      accessClientId,
      accessClientSecret,
      origins: configured,
    };
  } else {
    try {
      const token = await (
        dependencies.readSecretInput ?? (() => readConnectionToken(process.stdin, process.stderr))
      )();
      credential = decodeConnectionCredential(token);
    } catch {
      throw new CliError("invalid_connection_credential", "invalid connection credential");
    }
  }

  const owner = credential.origins?.owner ?? defaultOrigins(credential.domain).owner;
  let response: Response;
  try {
    response = await authenticatedFetch(
      {
        ...dependencies,
        env: {
          CF_ACCESS_CLIENT_ID: credential.accessClientId,
          CF_ACCESS_CLIENT_SECRET: credential.accessClientSecret,
        },
      },
      `${owner}/health`,
      { method: "GET" },
    );
  } catch (cause) {
    const status = cause instanceof AuthenticatedRedirectError ? cause.status : undefined;
    throw new CliError(
      "connection_verification_failed",
      status === undefined
        ? "connection verification failed"
        : `connection verification failed with status ${status}`,
      status,
    );
  }
  if (!response.ok) {
    throw new CliError(
      "connection_verification_failed",
      `connection verification failed with status ${response.status}`,
      response.status,
    );
  }
  await verifyConnectionHealth(response);

  let path: string;
  try {
    path = await (dependencies.persistConnection?.(credential) ??
      persistConnectionCredential(credential, {
        env: dependencies.env,
        currentUid: dependencies.currentUid,
      }));
  } catch {
    throw new CliError("connection_persistence_failed", "unable to save connection credential");
  }
  return { domain: credential.domain, path, connected: true };
}

export async function connectNamed(
  dependencies: CliDependencies,
  name: string,
  fromEnvironment = false,
): Promise<{ instance: string; connected: true }> {
  const config = await (dependencies.loadProfileConfiguration?.() ??
    loadProfileConfig(dependencies));
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name) || name.length > 48)
    throw new CliError("usage_error", "invalid instance name");
  const existingProfile = config.instances[name];
  const envName = existingProfile
    ? effectiveTokenEnv(name, existingProfile)
    : normalizedTokenEnv(name);
  let token: string;
  if (fromEnvironment) {
    const value = dependencies.env[envName];
    if (value === undefined) throw new CliError("auth_required", `${envName} is required`);
    token = value;
  } else {
    try {
      token = await (
        dependencies.readSecretInput ?? (() => readConnectionToken(process.stdin, process.stderr))
      )();
    } catch {
      throw new CliError("invalid_credential", "invalid connection credential");
    }
  }
  let profile: InstanceProfile;
  let credential: ConnectionCredential | undefined;
  if (existingProfile?.type === "native") {
    if (!/^shlook_api_v1_[A-Za-z0-9_-]{43}$/.test(token))
      throw new CliError("invalid_credential", "invalid connection credential");
    profile = existingProfile;
  } else {
    try {
      credential = decodeConnectionCredential(token);
    } catch {
      throw new CliError("invalid_credential", "invalid connection credential");
    }
    if (credential.origins === undefined)
      throw new CliError(
        "invalid_credential",
        "a complete connection credential with origins is required",
      );
    profile = {
      type: "cloudflare",
      url: credential.origins.owner,
      origins: {
        private: credential.origins.private,
        public: credential.origins.public,
        share: credential.origins.share,
      },
      ...(existingProfile?.token_env ? { token_env: existingProfile.token_env } : {}),
    };
    if (
      existingProfile &&
      (existingProfile.type !== "cloudflare" ||
        existingProfile.url !== profile.url ||
        JSON.stringify(existingProfile.origins) !== JSON.stringify(profile.origins))
    )
      throw new CliError(
        "invalid_credential",
        "connection credential does not match instance origins",
      );
  }
  if (!existingProfile) {
    try {
      validateProfileConfig({
        ...config,
        instances: { ...config.instances, [name]: profile },
      });
    } catch {
      throw new CliError(
        "invalid_configuration",
        "instance profile conflicts with configured instances",
      );
    }
  }
  let response: Response;
  try {
    const headers =
      profile.type === "native"
        ? new Headers({ Authorization: `Bearer ${token}` })
        : new Headers({
            "CF-Access-Client-Id": credential!.accessClientId,
            "CF-Access-Client-Secret": credential!.accessClientSecret,
            "x-shlook-client": "1",
          });
    response = await dependencies.fetch(`${profile.url}/health`, {
      method: "GET",
      headers,
      redirect: "manual",
    });
  } catch {
    throw new CliError("connection_verification_failed", "connection verification failed");
  }
  if (!response.ok)
    throw new CliError(
      "connection_verification_failed",
      `connection verification failed with status ${response.status}`,
      response.status,
    );
  await verifyConnectionHealth(response);
  if (dependencies.saveProfileCredential === undefined)
    throw new CliError("connection_persistence_failed", "unable to save connection credential");
  try {
    await saveNamedCredential(dependencies, name, profile.type, profile.url, token);
  } catch {
    throw new CliError("connection_persistence_failed", "unable to save connection credential");
  }
  if (!existingProfile) {
    config.instances[name] = profile;
    try {
      const validated = validateProfileConfig(config);
      if (dependencies.saveProfileConfiguration !== undefined)
        await dependencies.saveProfileConfiguration(validated);
      else await saveProfileConfig(dependencies, validated);
    } catch {
      throw new CliError("connection_persistence_failed", "unable to save instance configuration");
    }
  }
  return { instance: name, connected: true };
}
