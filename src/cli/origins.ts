import { loadConnectionCredential, type ConnectionCredential } from "../cli-connection.ts";

import { CliError } from "./errors.ts";
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
): Promise<CliDependencies> {
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
  return origins(dependencies).owner;
}

export function privateOrigin(dependencies: CliDependencies): string {
  return origins(dependencies).private;
}
