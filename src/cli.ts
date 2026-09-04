#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { normalizeAssetMetadata } from "./asset-metadata.ts";
import {
  inspectPackagedSetup,
  loadPublishInput,
  sanitizeCliValue,
  setupPlanData,
  type PublishInput,
  type SetupInspection,
} from "./cli-files.ts";
import {
  decodeConnectionCredential,
  loadConnectionCredential,
  persistConnectionCredential,
  type ConnectionCredential,
} from "./cli-connection.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const assetIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface CliDependencies {
  cwd: string;
  packageRoot?: string;
  nodeExecutable?: string;
  wranglerPath?: string;
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  runCommand: (command: string, args: string[], cwd: string) => Promise<{ code: number }>;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  readSecretInput?: () => Promise<string>;
  persistConnection?: (credential: ConnectionCredential) => Promise<string>;
  loadConnection?: () => Promise<ConnectionCredential>;
  loadPublishInput?: (path: string, entrypoint?: string) => Promise<PublishInput>;
  parseArguments?: (argv: string[]) => { positionals: string[]; options: CliOptions };
  inspectSetup?: () => Promise<SetupInspection>;
}

interface CliOptions {
  json?: boolean;
  plan?: boolean;
  apply?: boolean;
  entrypoint?: string;
  name?: string;
  description?: string;
  offset?: string;
}

class CliError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly details?: unknown;
  readonly exitCode: number;

  constructor(code: string, message: string, status?: number, details?: unknown, exitCode = 1) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
    this.exitCode = exitCode;
  }
}

function commandRunner(command: string, args: string[], cwd: string): Promise<{ code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code: code ?? 1 }));
  });
}

function resolvePinnedWrangler(): string {
  const packagePath = createRequire(import.meta.url).resolve("wrangler/package.json");
  return join(dirname(packagePath), "bin", "wrangler.js");
}

async function readSecretInput(): Promise<string> {
  if (process.stdin.isTTY) throw new Error("connection credential input is required");
  let value = "";
  for await (const chunk of process.stdin) {
    value += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (value.length > 20_000) throw new Error("connection credential input is invalid");
  }
  return value.trim();
}

function defaults(): CliDependencies {
  return {
    cwd: process.cwd(),
    packageRoot: PACKAGE_ROOT,
    nodeExecutable: process.execPath,
    wranglerPath: resolvePinnedWrangler(),
    env: process.env,
    fetch: globalThis.fetch,
    runCommand: commandRunner,
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
    readSecretInput,
  };
}

function parse(argv: string[]): { positionals: string[]; options: CliOptions } {
  try {
    const { positionals, values } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean" },
        plan: { type: "boolean" },
        apply: { type: "boolean" },
        entrypoint: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        offset: { type: "string" },
      },
    });
    return { positionals, options: values };
  } catch {
    throw new CliError("usage_error", "invalid arguments");
  }
}

const connectionEnvironmentKeys = [
  "CF_ACCESS_CLIENT_ID",
  "CF_ACCESS_CLIENT_SECRET",
  "SHLOOK_DOMAIN",
  "SHLOOK_API_ORIGIN",
  "SHLOOK_PRIVATE_ORIGIN",
  "SHLOOK_PUBLIC_ORIGIN",
  "SHLOOK_SHARE_ORIGIN",
] as const;

function usesConnectionProfile(positionals: string[]): boolean {
  const [command, operation] = positionals;
  if (command === "auth") return operation === "check";
  return [
    "status",
    "publish",
    "list",
    "show",
    "visibility",
    "secret",
    "share",
    "hard",
    "delete",
    "verify",
  ].includes(command ?? "");
}

async function withConnectionProfile(dependencies: CliDependencies): Promise<CliDependencies> {
  const hasEnvironmentProfile = connectionEnvironmentKeys.some(
    (key) => dependencies.env[key] !== undefined,
  );
  if (hasEnvironmentProfile) {
    const hasCredentials =
      dependencies.env.CF_ACCESS_CLIENT_ID !== undefined &&
      dependencies.env.CF_ACCESS_CLIENT_SECRET !== undefined;
    if (!hasCredentials) {
      throw new CliError(
        "auth_required",
        "CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are required",
      );
    }
    const hasDomain = dependencies.env.SHLOOK_DOMAIN !== undefined;
    const hasAllOrigins = [
      dependencies.env.SHLOOK_API_ORIGIN,
      dependencies.env.SHLOOK_PRIVATE_ORIGIN,
      dependencies.env.SHLOOK_PUBLIC_ORIGIN,
      dependencies.env.SHLOOK_SHARE_ORIGIN,
    ].every((value) => value !== undefined);
    if (!hasDomain && !hasAllOrigins) {
      throw new CliError(
        "configuration_required",
        "SHLOOK_DOMAIN or all four shlook origins are required",
      );
    }
    return dependencies;
  }

  let credential: ConnectionCredential;
  try {
    credential = await (dependencies.loadConnection?.() ??
      loadConnectionCredential({ env: dependencies.env }));
  } catch {
    throw new CliError(
      "auth_required",
      "a complete environment profile or stored connection is required",
    );
  }
  return {
    ...dependencies,
    env: {
      ...dependencies.env,
      SHLOOK_DOMAIN: credential.domain,
      CF_ACCESS_CLIENT_ID: credential.accessClientId,
      CF_ACCESS_CLIENT_SECRET: credential.accessClientSecret,
    },
  };
}

function requireAssetId(value: string | undefined): string {
  if (value === undefined || !assetIdPattern.test(value))
    throw new CliError("usage_error", "a valid asset ID is required");
  return value;
}

function ownerHeaders(dependencies: CliDependencies, jsonBody = false): Headers {
  const id = dependencies.env.CF_ACCESS_CLIENT_ID;
  const secret = dependencies.env.CF_ACCESS_CLIENT_SECRET;
  if (id === undefined || secret === undefined) {
    throw new CliError(
      "auth_required",
      "CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are required",
    );
  }
  const headers = new Headers({
    "CF-Access-Client-Id": id,
    "CF-Access-Client-Secret": secret,
    "x-shlook-client": "1",
  });
  if (jsonBody) headers.set("content-type", "application/json");
  return headers;
}

function configuredOrigin(value: string | undefined, name: string): string {
  if (value === undefined) throw new CliError("configuration_required", `${name} is required`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError("invalid_configuration", `${name} must be a valid URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new CliError("invalid_configuration", `${name} must be an HTTPS origin without a path`);
  }
  return url.origin;
}

function configuredDomain(value: string | undefined): string {
  if (value === undefined) {
    throw new CliError(
      "configuration_required",
      "SHLOOK_DOMAIN is required when an origin override is not configured",
    );
  }
  let url: URL;
  try {
    url = new URL(`https://${value}`);
  } catch {
    throw new CliError("invalid_configuration", "SHLOOK_DOMAIN must be a bare domain name");
  }
  if (url.hostname !== value || url.port !== "" || url.pathname !== "/") {
    throw new CliError("invalid_configuration", "SHLOOK_DOMAIN must be a bare domain name");
  }
  return url.hostname;
}

function defaultOrigins(domain: string) {
  return {
    owner: `https://shlook.${domain}`,
    private: `https://private.${domain}`,
    public: `https://public.${domain}`,
    share: `https://share.${domain}`,
  };
}

function origins(dependencies: CliDependencies) {
  const configured = [
    dependencies.env.SHLOOK_API_ORIGIN,
    dependencies.env.SHLOOK_PRIVATE_ORIGIN,
    dependencies.env.SHLOOK_PUBLIC_ORIGIN,
    dependencies.env.SHLOOK_SHARE_ORIGIN,
  ];
  const defaults = configured.every((value) => value !== undefined)
    ? undefined
    : defaultOrigins(configuredDomain(dependencies.env.SHLOOK_DOMAIN));
  const owner = configuredOrigin(
    dependencies.env.SHLOOK_API_ORIGIN ?? defaults?.owner,
    "SHLOOK_API_ORIGIN",
  );
  const privateOrigin = configuredOrigin(
    dependencies.env.SHLOOK_PRIVATE_ORIGIN ?? defaults?.private,
    "SHLOOK_PRIVATE_ORIGIN",
  );
  const publicOrigin = configuredOrigin(
    dependencies.env.SHLOOK_PUBLIC_ORIGIN ?? defaults?.public,
    "SHLOOK_PUBLIC_ORIGIN",
  );
  const share = configuredOrigin(
    dependencies.env.SHLOOK_SHARE_ORIGIN ?? defaults?.share,
    "SHLOOK_SHARE_ORIGIN",
  );
  if (new Set([owner, privateOrigin, publicOrigin, share]).size !== 4) {
    throw new CliError("invalid_configuration", "shlook requires four distinct origins");
  }
  return { owner, private: privateOrigin, public: publicOrigin, share };
}

function origin(dependencies: CliDependencies): string {
  return origins(dependencies).owner;
}

function privateOrigin(dependencies: CliDependencies): string {
  return origins(dependencies).private;
}

async function responseData(response: Response): Promise<unknown> {
  if (!response.ok)
    throw new CliError(
      "api_error",
      `API request failed with status ${response.status}`,
      response.status,
    );
  if (response.status === 204) return null;
  const type = response.headers.get("content-type") ?? "";
  return type.includes("application/json") ? response.json() : { status: response.status };
}

async function api(
  dependencies: CliDependencies,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  const response = await dependencies.fetch(`${origin(dependencies)}${path}`, {
    method,
    headers: ownerHeaders(dependencies, body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return responseData(response);
}

async function setupInspection(dependencies: CliDependencies): Promise<SetupInspection> {
  return (
    dependencies.inspectSetup?.() ??
    inspectPackagedSetup(
      dependencies.packageRoot ?? PACKAGE_ROOT,
      dependencies.wranglerPath ?? resolvePinnedWrangler(),
    )
  );
}

async function setupPlan(dependencies: CliDependencies) {
  const defaults =
    dependencies.env.SHLOOK_DOMAIN === undefined
      ? undefined
      : defaultOrigins(configuredDomain(dependencies.env.SHLOOK_DOMAIN));
  const configured = {
    owner:
      dependencies.env.SHLOOK_API_ORIGIN === undefined
        ? defaults?.owner
        : configuredOrigin(dependencies.env.SHLOOK_API_ORIGIN, "SHLOOK_API_ORIGIN"),
    private:
      dependencies.env.SHLOOK_PRIVATE_ORIGIN === undefined
        ? defaults?.private
        : configuredOrigin(dependencies.env.SHLOOK_PRIVATE_ORIGIN, "SHLOOK_PRIVATE_ORIGIN"),
    public:
      dependencies.env.SHLOOK_PUBLIC_ORIGIN === undefined
        ? defaults?.public
        : configuredOrigin(dependencies.env.SHLOOK_PUBLIC_ORIGIN, "SHLOOK_PUBLIC_ORIGIN"),
    share:
      dependencies.env.SHLOOK_SHARE_ORIGIN === undefined
        ? defaults?.share
        : configuredOrigin(dependencies.env.SHLOOK_SHARE_ORIGIN, "SHLOOK_SHARE_ORIGIN"),
  };
  const supplied = Object.values(configured).filter((value) => value !== undefined);
  if (new Set(supplied).size !== supplied.length) {
    throw new CliError("invalid_configuration", "configured shlook origins must be distinct");
  }
  return setupPlanData(await setupInspection(dependencies), configured);
}

async function setupApply(dependencies: CliDependencies): Promise<never> {
  throw new CliError(
    "setup_not_automated",
    "setup apply is intentionally unavailable; follow the setup reference with an operator-owned Wrangler config",
    undefined,
    {
      status: "blocked",
      plan: await setupPlan(dependencies),
    },
    2,
  );
}

async function connect(
  dependencies: CliDependencies,
  args: string[],
): Promise<{ domain: string; path: string; connected: true }> {
  if (args.length !== 0) {
    throw new CliError("usage_error", "connect reads its credential from standard input");
  }

  let credential: ConnectionCredential;
  try {
    const token = await (dependencies.readSecretInput ?? readSecretInput)();
    credential = decodeConnectionCredential(token);
  } catch {
    throw new CliError("invalid_connection_credential", "invalid connection credential");
  }

  const owner = defaultOrigins(credential.domain).owner;
  let response: Response;
  try {
    response = await dependencies.fetch(`${owner}/health`, {
      method: "GET",
      redirect: "manual",
      headers: ownerHeaders({
        ...dependencies,
        env: {
          CF_ACCESS_CLIENT_ID: credential.accessClientId,
          CF_ACCESS_CLIENT_SECRET: credential.accessClientSecret,
        },
      }),
    });
  } catch {
    throw new CliError("connection_verification_failed", "connection verification failed");
  }
  if (!response.ok) {
    throw new CliError(
      "connection_verification_failed",
      `connection verification failed with status ${response.status}`,
      response.status,
    );
  }

  let path: string;
  try {
    path = await (dependencies.persistConnection?.(credential) ??
      persistConnectionCredential(credential, { env: dependencies.env }));
  } catch {
    throw new CliError("connection_persistence_failed", "unable to save connection credential");
  }
  return { domain: credential.domain, path, connected: true };
}

function encodedPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function publish(
  dependencies: CliDependencies,
  path: string | undefined,
  nameValue: string | undefined,
  descriptionValue: string | undefined,
  entrypoint?: string,
): Promise<unknown> {
  if (path === undefined) throw new CliError("usage_error", "publish requires a file or directory");
  const metadata = normalizeAssetMetadata(nameValue, descriptionValue);
  if (metadata === null) {
    throw new CliError(
      "usage_error",
      "publish requires --name with 1-80 characters; --description accepts up to 500 characters",
    );
  }
  let input: PublishInput;
  try {
    input = await (dependencies.loadPublishInput ?? loadPublishInput)(path, entrypoint);
  } catch (cause) {
    throw new CliError(
      "unsafe_publish_input",
      cause instanceof Error ? cause.message : "invalid publish input",
    );
  }
  const created = (await api(dependencies, "/api/assets", "POST", metadata)) as {
    asset?: { id?: unknown };
  };
  const id = created.asset?.id;
  if (typeof id !== "string" || !assetIdPattern.test(id))
    throw new CliError("invalid_api_response", "create response did not include an asset ID");

  const files: Array<{ path: string; uploadId: string }> = [];
  let stage = "upload";
  try {
    for (const file of input.files) {
      const response = await dependencies.fetch(
        `${origin(dependencies)}/api/assets/${id}/files/${encodedPath(file.path)}`,
        {
          method: "PUT",
          headers: new Headers([...ownerHeaders(dependencies), ["content-type", file.contentType]]),
          body: file.bytes.buffer.slice(
            file.bytes.byteOffset,
            file.bytes.byteOffset + file.bytes.byteLength,
          ) as ArrayBuffer,
        },
      );
      const uploaded = (await responseData(response)) as { file?: { uploadId?: unknown } };
      if (typeof uploaded.file?.uploadId !== "string")
        throw new CliError("invalid_api_response", "upload response did not include an upload ID");
      files.push({ path: file.path, uploadId: uploaded.file.uploadId });
    }
    stage = "finalize";
    return await api(dependencies, `/api/assets/${id}/finalize`, "POST", {
      entrypoint: input.entrypoint,
      files,
    });
  } catch {
    let cleanupSucceeded = false;
    try {
      await api(dependencies, `/api/assets/${id}`, "DELETE");
      cleanupSucceeded = true;
    } catch {
      // The original publication error remains authoritative.
    }
    throw new CliError("publish_failed", `publication failed during ${stage}`, undefined, {
      assetId: id,
      stage,
      cleanup: { attempted: true, succeeded: cleanupSucceeded },
    });
  }
}

function expiryValue(value: string | undefined): string | null {
  if (value === "none") return null;
  if (value === undefined || Number.isNaN(Date.parse(value)))
    throw new CliError("usage_error", "expiry requires an ISO date or none");
  return value;
}

async function verify(dependencies: CliDependencies, rawId: string | undefined): Promise<unknown> {
  const assetId = requireAssetId(rawId);
  const metadata = (await api(dependencies, `/api/assets/${assetId}`)) as {
    asset?: { state?: unknown };
  };
  if (metadata.asset?.state !== "live")
    throw new CliError("verification_failed", "asset is not live");
  const response = await dependencies.fetch(`${privateOrigin(dependencies)}/assets/${assetId}/`, {
    method: "GET",
    headers: ownerHeaders(dependencies),
  });
  if (!response.ok)
    throw new CliError(
      "verification_failed",
      `artifact returned status ${response.status}`,
      response.status,
    );
  return { assetId, verified: true, status: response.status };
}

async function dispatch(
  positionals: string[],
  options: CliOptions,
  dependencies: CliDependencies,
): Promise<{ command: string; data: unknown; exitCode?: number; allowSecrets?: boolean }> {
  const [command, ...args] = positionals;
  if (command === undefined) throw new CliError("usage_error", "a command is required");
  if (command === "connect") return { command, data: await connect(dependencies, args) };
  if (usesConnectionProfile(positionals)) {
    dependencies = await withConnectionProfile(dependencies);
  }
  if (command === "auth" && args[0] === "check")
    return { command: "auth", data: await api(dependencies, "/health") };
  if (command === "setup") {
    if (options.plan === options.apply)
      throw new CliError("usage_error", "setup requires exactly one of --plan or --apply");
    if (options.plan) return { command, data: await setupPlan(dependencies) };
    await setupApply(dependencies);
  }
  if (command === "status") return { command, data: await api(dependencies, "/health") };
  if (command === "publish")
    return {
      command,
      data: await publish(
        dependencies,
        args[0],
        options.name,
        options.description,
        options.entrypoint,
      ),
    };
  if (command === "list") {
    const offset =
      options.offset === undefined ? "" : `?offset=${encodeURIComponent(options.offset)}`;
    return { command, data: await api(dependencies, `/api/assets${offset}`) };
  }
  if (command === "show")
    return { command, data: await api(dependencies, `/api/assets/${requireAssetId(args[0])}`) };
  if (command === "visibility") {
    const id = requireAssetId(args[0]);
    if (!["private", "secret_link", "public"].includes(args[1] ?? ""))
      throw new CliError("usage_error", "invalid visibility");
    return {
      command,
      data: await api(dependencies, `/api/assets/${id}/visibility`, "PATCH", {
        visibility: args[1],
      }),
    };
  }
  if (command === "secret") {
    const [operation, rawId] = args;
    const id = requireAssetId(rawId);
    if (!["create", "rotate", "revoke"].includes(operation ?? ""))
      throw new CliError("usage_error", "invalid secret operation");
    const method = operation === "revoke" ? "DELETE" : "POST";
    const query = method === "POST" ? `?mode=${operation}` : "";
    return {
      command,
      data: await api(dependencies, `/api/assets/${id}/secret${query}`, method),
      allowSecrets: method === "POST",
    };
  }
  if ((command === "share" || command === "hard") && args[0] === "expiry") {
    const id = requireAssetId(args[1]);
    const field = command === "share" ? "shareExpiresAt" : "hardExpiresAt";
    return {
      command,
      data: await api(dependencies, `/api/assets/${id}/expiry`, "PATCH", {
        [field]: expiryValue(args[2]),
      }),
    };
  }
  if (command === "delete")
    return {
      command,
      data: await api(dependencies, `/api/assets/${requireAssetId(args[0])}`, "DELETE"),
    };
  if (command === "verify") return { command, data: await verify(dependencies, args[0]) };
  throw new CliError("usage_error", `unknown command: ${command}`);
}

export async function runCli(
  argv: string[],
  dependencies: CliDependencies = defaults(),
): Promise<number> {
  let command = argv.find((value) => !value.startsWith("-")) ?? "unknown";
  let json = argv.includes("--json");
  try {
    const parsed = dependencies.parseArguments?.(argv) ?? parse(argv);
    json = parsed.options.json ?? false;
    command = parsed.positionals[0] ?? "unknown";
    const result = await dispatch(parsed.positionals, parsed.options, dependencies);
    const data = result.allowSecrets ? result.data : sanitizeCliValue(result.data);
    const output = { ok: true, command: result.command, data };
    dependencies.stdout(`${JSON.stringify(output, null, json ? 0 : 2)}\n`);
    return result.exitCode ?? 0;
  } catch (cause) {
    const error =
      cause instanceof CliError
        ? cause
        : new CliError(
            "unexpected_error",
            cause instanceof Error ? cause.message : "unexpected error",
          );
    const output = {
      ok: false,
      command,
      error: {
        code: error.code,
        message: error.message,
        ...(error.status === undefined ? {} : { status: error.status }),
        ...(error.details === undefined ? {} : { details: sanitizeCliValue(error.details) }),
      },
    };
    dependencies.stderr(json ? `${JSON.stringify(output)}\n` : `shlook: ${error.message}\n`);
    return error.exitCode;
  }
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2));
