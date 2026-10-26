import { constants } from "node:fs";
import { mkdir, open, realpath, rename, unlink, writeFile, chmod, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  atomicReplaceOwnerFile,
  assertCanonicalPathComponents,
  safeAbsoluteBasePath,
  errorCode,
} from "./storage/owner-files.ts";
import { CliError } from "./errors.ts";
import type { CliDependencies } from "./types.ts";

export interface NativeProfile {
  type: "native";
  url: string;
  token_env?: string;
  allow_loopback_http?: true;
}
export interface CloudflareProfile {
  type: "cloudflare";
  url: string;
  origins: { private: string; public: string; share: string };
  token_env?: string;
}
export type InstanceProfile = NativeProfile | CloudflareProfile;
export interface ProfileConfig {
  version: 1;
  default?: string;
  instances: Record<string, InstanceProfile>;
}
const namePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const envPattern = /^[A-Z_][A-Z0-9_]*$/;
const connectPrefix = "shlook_connect_v1_";
const maxConfigBytes = 64_000;
const fileSystem = {
  mkdir,
  realpath,
  writeFile,
  rename,
  chmod,
  unlink,
  open: async (path: string, flags: number) => open(path, flags),
};

export function profileNameValid(name: string): boolean {
  return name.length <= 48 && namePattern.test(name);
}
export function normalizedTokenEnv(name: string): string {
  return `SHLOOK_API_TOKEN_${name.replaceAll("-", "_").toUpperCase()}`;
}
function configDir(env: Readonly<Record<string, string | undefined>>, home = homedir()): string {
  const base = env.XDG_CONFIG_HOME
    ? safeAbsoluteBasePath(env.XDG_CONFIG_HOME, "invalid configuration path")
    : join(home, ".config");
  return join(safeAbsoluteBasePath(base, "invalid configuration path"), "shlook");
}
export function profileConfigPath(
  dependencies: Pick<CliDependencies, "env"> & { home?: string },
): string {
  return join(configDir(dependencies.env, dependencies.home), "config.json");
}
function canonicalOrigin(value: unknown, allowHttp = false): string {
  if (typeof value !== "string") throw new Error("invalid origin");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid origin");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(allowHttp && loopback && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    value !== url.origin
  )
    throw new Error("invalid origin");
  return url.origin;
}
export function validateProfileConfig(value: unknown): ProfileConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid configuration");
  const top = value as Record<string, unknown>;
  if (
    Object.keys(top).some((key) => !["version", "default", "instances"].includes(key)) ||
    top.version !== 1 ||
    !top.instances ||
    typeof top.instances !== "object" ||
    Array.isArray(top.instances)
  )
    throw new Error("invalid configuration");
  const entries = Object.entries(top.instances as Record<string, unknown>);
  if (entries.length > 100) throw new Error("invalid configuration");
  const envNames = new Set<string>();
  const instances: Record<string, InstanceProfile> = {};
  for (const [name, raw] of entries) {
    if (!profileNameValid(name) || !raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("invalid configuration");
    const item = raw as Record<string, unknown>;
    const type = item.type;
    const permitted =
      type === "native"
        ? ["type", "url", "token_env", "allow_loopback_http"]
        : type === "cloudflare"
          ? ["type", "url", "origins", "token_env"]
          : [];
    if (!permitted.length || Object.keys(item).some((key) => !permitted.includes(key)))
      throw new Error("invalid configuration");
    if (
      item.token_env !== undefined &&
      (typeof item.token_env !== "string" || !envPattern.test(item.token_env))
    )
      throw new Error("invalid configuration");
    const tokenEnv = (item.token_env as string | undefined) ?? normalizedTokenEnv(name);
    if (envNames.has(tokenEnv)) throw new Error("invalid configuration");
    envNames.add(tokenEnv);
    const allow = type === "native" && item.allow_loopback_http === true;
    if (item.allow_loopback_http !== undefined && !allow) throw new Error("invalid configuration");
    const url = canonicalOrigin(item.url, allow);
    if (type === "native")
      instances[name] = {
        type,
        url,
        ...(item.token_env === undefined ? {} : { token_env: tokenEnv }),
        ...(allow ? { allow_loopback_http: true } : {}),
      };
    else {
      if (
        !item.origins ||
        typeof item.origins !== "object" ||
        Array.isArray(item.origins) ||
        Object.keys(item.origins).sort().join(",") !== "private,public,share"
      )
        throw new Error("invalid configuration");
      const origins = item.origins as Record<string, unknown>;
      const validOrigins = {
        private: canonicalOrigin(origins.private),
        public: canonicalOrigin(origins.public),
        share: canonicalOrigin(origins.share),
      };
      if (new Set([url, ...Object.values(validOrigins)]).size !== 4)
        throw new Error("invalid configuration");
      instances[name] = {
        type: "cloudflare",
        url,
        origins: validOrigins,
        ...(item.token_env === undefined ? {} : { token_env: tokenEnv }),
      };
    }
  }
  if (
    top.default !== undefined &&
    (typeof top.default !== "string" || !Object.hasOwn(instances, top.default))
  )
    throw new Error("invalid configuration");
  return {
    version: 1,
    ...(top.default === undefined ? {} : { default: top.default as string }),
    instances,
  };
}
export async function loadProfileConfig(
  dependencies: Pick<CliDependencies, "env" | "currentUid">,
): Promise<ProfileConfig> {
  const path = profileConfigPath(dependencies);
  const uid = dependencies.currentUid?.() ?? process.getuid?.();
  try {
    try {
      await stat(path);
    } catch (cause) {
      if (errorCode(cause) === "ENOENT") return { version: 1, instances: {} };
      throw cause;
    }
    if (uid === undefined) throw new Error("secure owner checks unavailable");
    await assertCanonicalPathComponents(path, fileSystem, "unsafe configuration path");
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.uid !== uid ||
        (stat.mode & 0o7777) !== 0o600 ||
        stat.size > maxConfigBytes
      )
        throw new Error();
      return validateProfileConfig(JSON.parse(await handle.readFile({ encoding: "utf8" })));
    } finally {
      await handle.close();
    }
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return { version: 1, instances: {} };
    throw new CliError("invalid_configuration", "unable to load instance configuration");
  }
}
export async function saveProfileConfig(
  dependencies: Pick<CliDependencies, "env">,
  config: ProfileConfig,
): Promise<void> {
  const path = profileConfigPath(dependencies);
  const id = randomUUID();
  try {
    await atomicReplaceOwnerFile({
      path,
      temporaryPath: join(dirname(path), `.config.json.${id}`),
      data: `${JSON.stringify(validateProfileConfig(config), null, 2)}\n`,
      fs: fileSystem,
      unsafePathMessage: "unsafe configuration path",
      enforceDirectoryMode: true,
      validateTemporaryPath: true,
      cleanup: "always-on-failure",
    });
  } catch {
    throw new CliError("invalid_configuration", "unable to save instance configuration");
  }
}
export function effectiveTokenEnv(name: string, profile: InstanceProfile): string {
  return profile.token_env ?? normalizedTokenEnv(name);
}
export async function resolveNamedToken(
  dependencies: CliDependencies,
  name: string,
  profile: InstanceProfile,
): Promise<string> {
  const envName = effectiveTokenEnv(name, profile);
  const value = dependencies.env[envName];
  const validate = (candidate: string) => {
    if (
      profile.type === "native"
        ? !/^shlook_api_v1_[A-Za-z0-9_-]{43}$/.test(candidate)
        : !candidate.startsWith(connectPrefix)
    )
      throw new CliError("invalid_credential", "configured credential is invalid");
    return candidate;
  };
  if (value !== undefined) return validate(value);
  const saved = await dependencies.loadProfileCredential?.(name, profile.type, profile.url);
  if (saved !== undefined) return validate(saved);
  throw new CliError(
    "auth_required",
    `authentication required for instance ${name}; set ${envName} or run connect --instance ${name}`,
  );
}
export async function saveNamedCredential(
  dependencies: CliDependencies,
  name: string,
  type: "native" | "cloudflare",
  url: string,
  token: string,
): Promise<void> {
  await dependencies.saveProfileCredential?.(name, type, url, token);
}
export async function loadStoredNamedCredential(
  dependencies: CliDependencies,
  name: string,
  type: "native" | "cloudflare",
  url: string,
): Promise<string | undefined> {
  return dependencies.loadProfileCredential?.(name, type, url);
}

export async function instanceCommand(
  args: string[],
  options: import("./types.ts").CliOptions,
  dependencies: CliDependencies,
): Promise<unknown> {
  const [operation, name] = args;
  const config = await loadProfileConfig(dependencies);
  if (operation === "list" && name === undefined)
    return {
      instances: Object.entries(config.instances).map(([profileName, profile]) => ({
        name: profileName,
        type: profile.type,
        url: profile.url,
        token_env: effectiveTokenEnv(profileName, profile),
        default: config.default === profileName,
      })),
    };
  if (operation === "add") {
    if (
      !name ||
      !profileNameValid(name) ||
      Object.hasOwn(config.instances, name) ||
      options.url === undefined
    )
      throw new CliError(
        "usage_error",
        "instance add requires a new valid name and --url <origin>",
      );
    if (options.tokenEnv !== undefined && !envPattern.test(options.tokenEnv))
      throw new CliError("usage_error", "invalid token environment variable name");
    const allow = options.allowLoopbackHttp === true;
    let url: string;
    try {
      url = canonicalOrigin(options.url, allow);
    } catch {
      throw new CliError(
        options.url.startsWith("http:") ? "https_required" : "invalid_configuration",
        "instance URL must be a canonical HTTPS origin",
      );
    }
    config.instances[name] = {
      type: "native",
      url,
      ...(options.tokenEnv ? { token_env: options.tokenEnv } : {}),
      ...(allow ? { allow_loopback_http: true } : {}),
    };
    const validated = validateProfileConfig(config);
    await saveProfileConfig(dependencies, validated);
    return {
      name,
      type: "native",
      url,
      token_env: effectiveTokenEnv(name, validated.instances[name]!),
      default: false,
    };
  }
  if (operation === "default") {
    if (!name || !Object.hasOwn(config.instances, name))
      throw new CliError("instance_not_found", `instance not found: ${name ?? ""}`);
    config.default = name;
    await saveProfileConfig(dependencies, config);
    return { default: name };
  }
  if (operation === "remove") {
    if (!name || !Object.hasOwn(config.instances, name))
      throw new CliError("instance_not_found", `instance not found: ${name ?? ""}`);
    delete config.instances[name];
    if (config.default === name) delete config.default;
    await saveProfileConfig(dependencies, config);
    await dependencies.removeProfileCredential?.(name);
    return { removed: name, default: config.default ?? null };
  }
  throw new CliError("usage_error", "invalid instance command");
}
