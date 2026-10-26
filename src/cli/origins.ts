import { loadConnectionCredential, type ConnectionCredential } from "../cli-connection.ts";

import { CliError } from "./errors.ts";
import {
  loadProfileConfig,
  resolveNamedToken,
  effectiveTokenEnv,
  saveNamedCredential,
  type InstanceProfile,
} from "./profiles.ts";
import type { CliDependencies } from "./types.ts";

const connectionEnvironmentKeys = [
  "CF_ACCESS_CLIENT_ID",
  "CF_ACCESS_CLIENT_SECRET",
  "SHLOOK_DOMAIN",
  "SHLOOK_API_ORIGIN",
  "SHLOOK_PRIVATE_ORIGIN",
  "SHLOOK_PUBLIC_ORIGIN",
  "SHLOOK_SHARE_ORIGIN",
] as const;

export function defaultOrigins(domain: string) {
  return {
    owner: `https://shlook.${domain}`,
    private: `https://private.${domain}`,
    public: `https://public.${domain}`,
    share: `https://share.${domain}`,
  };
}

export function usesConnectionProfile(positionals: string[]): boolean {
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

export async function withConnectionProfile(
  dependencies: CliDependencies,
  selectedName?: string,
): Promise<CliDependencies> {
  const hasLegacySelector = connectionEnvironmentKeys.some(
    (key) => dependencies.env[key] !== undefined,
  );
  if (selectedName === undefined && hasLegacySelector)
    return withLegacyConnectionProfile(dependencies);
  const config = await loadProfileConfig(dependencies);
  const selected = selectedName ?? (!hasLegacySelector ? config.default : undefined);
  if (selectedName !== undefined || selected !== undefined) {
    const profile: InstanceProfile | undefined = config.instances[selected!];
    if (!profile) throw new CliError("instance_not_found", `instance not found: ${selected}`);
    const tokenEnv = effectiveTokenEnv(selected!, profile);
    let token: string;
    try {
      token = await resolveNamedToken(dependencies, selected!, profile);
    } catch (cause) {
      if (
        !(cause instanceof CliError) ||
        cause.code !== "auth_required" ||
        process.stdin.isTTY !== true ||
        dependencies.readSecretInput === undefined
      )
        throw cause;
      try {
        token = await dependencies.readSecretInput();
        let headers: Record<string, string>;
        if (profile.type === "native") {
          if (!/^shlook_api_v1_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error();
          headers = { Authorization: `Bearer ${token}` };
        } else {
          const { decodeConnectionCredential } = await import("../cli-connection.ts");
          const credential = decodeConnectionCredential(token);
          if (
            credential.origins?.owner !== profile.url ||
            credential.origins.private !== profile.origins.private ||
            credential.origins.public !== profile.origins.public ||
            credential.origins.share !== profile.origins.share
          )
            throw new Error();
          headers = {
            "CF-Access-Client-Id": credential.accessClientId,
            "CF-Access-Client-Secret": credential.accessClientSecret,
            "x-shlook-client": "1",
          };
        }
        const response = await dependencies.fetch(`${profile.url}/health`, {
          method: "GET",
          headers,
          redirect: "manual",
        });
        if (!response.ok || !(await validHealth(response))) throw new Error();
        await saveNamedCredential(dependencies, selected!, profile.type, profile.url, token);
      } catch {
        throw new CliError(
          "invalid_credential",
          "connection credential is invalid or could not be verified",
        );
      }
    }
    if (profile.type === "native")
      return {
        ...dependencies,
        backend: "native",
        instanceName: selected,
        selectedInstanceExplicit: selectedName !== undefined,
        selectedOrigin: profile.url,
        profileTokenEnv: tokenEnv,
        env: { ...dependencies.env, [tokenEnv]: token },
      };
    const { decodeConnectionCredential } = await import("../cli-connection.ts");
    let credential;
    try {
      credential = decodeConnectionCredential(token);
    } catch {
      throw new CliError("invalid_credential", "configured credential is invalid");
    }
    if (
      credential.origins === undefined ||
      credential.origins.owner !== profile.url ||
      credential.origins.private !== profile.origins.private ||
      credential.origins.public !== profile.origins.public ||
      credential.origins.share !== profile.origins.share
    )
      throw new CliError(
        "invalid_credential",
        "configured credential does not match instance origins",
      );
    return {
      ...dependencies,
      backend: "cloudflare",
      instanceName: selected,
      selectedOrigin: profile.url,
      env: {
        ...dependencies.env,
        CF_ACCESS_CLIENT_ID: credential.accessClientId,
        CF_ACCESS_CLIENT_SECRET: credential.accessClientSecret,
        SHLOOK_API_ORIGIN: profile.url,
        SHLOOK_PRIVATE_ORIGIN: profile.origins.private,
        SHLOOK_PUBLIC_ORIGIN: profile.origins.public,
        SHLOOK_SHARE_ORIGIN: profile.origins.share,
      },
    };
  }
  const hasEnvironmentProfile = hasLegacySelector;
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
      ...(credential.origins === undefined
        ? {}
        : {
            SHLOOK_API_ORIGIN: credential.origins.owner,
            SHLOOK_PRIVATE_ORIGIN: credential.origins.private,
            SHLOOK_PUBLIC_ORIGIN: credential.origins.public,
            SHLOOK_SHARE_ORIGIN: credential.origins.share,
          }),
    },
  };
}

async function validHealth(response: Response): Promise<boolean> {
  if (
    response.status === 204 ||
    (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() !==
      "application/json"
  )
    return false;
  try {
    const value: unknown = await response.json();
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 2 &&
      (value as { ok?: unknown }).ok === true &&
      (value as { service?: unknown }).service === "shlook"
    );
  } catch {
    return false;
  }
}

async function withLegacyConnectionProfile(
  dependencies: CliDependencies,
): Promise<CliDependencies> {
  const hasCredentials =
    dependencies.env.CF_ACCESS_CLIENT_ID !== undefined &&
    dependencies.env.CF_ACCESS_CLIENT_SECRET !== undefined;
  if (!hasCredentials)
    throw new CliError(
      "auth_required",
      "CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are required",
    );
  const hasDomain = dependencies.env.SHLOOK_DOMAIN !== undefined;
  const hasAllOrigins = [
    dependencies.env.SHLOOK_API_ORIGIN,
    dependencies.env.SHLOOK_PRIVATE_ORIGIN,
    dependencies.env.SHLOOK_PUBLIC_ORIGIN,
    dependencies.env.SHLOOK_SHARE_ORIGIN,
  ].every((value) => value !== undefined);
  if (!hasDomain && !hasAllOrigins)
    throw new CliError(
      "configuration_required",
      "SHLOOK_DOMAIN or all four shlook origins are required",
    );
  return dependencies;
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

export function origins(dependencies: CliDependencies) {
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

export function origin(dependencies: CliDependencies): string {
  if (dependencies.selectedOrigin !== undefined) return dependencies.selectedOrigin;
  return origins(dependencies).owner;
}

export function privateOrigin(dependencies: CliDependencies): string {
  if (dependencies.backend === "native") return dependencies.selectedOrigin!;
  return origins(dependencies).private;
}
