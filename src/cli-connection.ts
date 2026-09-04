import { constants } from "node:fs";
import { chmod, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, parse as parsePath } from "node:path";
import { randomUUID } from "node:crypto";

const tokenPrefix = "shlook_connect_v1_";
const credentialKeys = ["domain", "accessClientId", "accessClientSecret"] as const;
const domainPattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const maximumCredentialFileBytes = 16_384;

export interface ConnectionCredential {
  domain: string;
  accessClientId: string;
  accessClientSecret: string;
}

export interface ConnectionFileSystem {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  writeFile(
    path: string,
    data: string,
    options: { encoding: "utf8"; flag: "wx"; mode: number },
  ): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  chmod(path: string, mode: number): Promise<unknown>;
  open(path: string, flags: number): Promise<ConnectionFileHandle>;
  unlink(path: string): Promise<unknown>;
}

export interface ConnectionFileHandle {
  stat(): Promise<{
    isFile(): boolean;
    uid: number;
    mode: number;
    size: number;
  }>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface ConnectionDependencies {
  env?: Readonly<Record<string, string | undefined>>;
  home?: () => string;
  fs?: ConnectionFileSystem;
  randomId?: () => string;
  currentUid?: () => number | undefined;
}

const defaultFileSystem: ConnectionFileSystem = {
  mkdir,
  writeFile,
  rename,
  chmod,
  open: async (path, flags) => open(path, flags),
  unlink,
};

function invalidCredential(): Error {
  return new Error("invalid connection credential");
}

function ownDataString(value: object, key: string): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}

function validateCredential(value: unknown): ConnectionCredential {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidCredential();
  }
  const keys = Object.keys(value);
  if (keys.length !== credentialKeys.length || credentialKeys.some((key) => !keys.includes(key))) {
    throw invalidCredential();
  }

  const domain = ownDataString(value, "domain");
  const accessClientId = ownDataString(value, "accessClientId");
  const accessClientSecret = ownDataString(value, "accessClientSecret");
  if (
    domain === undefined ||
    !domain.includes(".") ||
    !domainPattern.test(domain) ||
    accessClientId === undefined ||
    accessClientSecret === undefined ||
    !validSecretValue(accessClientId) ||
    !validSecretValue(accessClientSecret)
  ) {
    throw invalidCredential();
  }
  return { domain, accessClientId, accessClientSecret };
}

function validSecretValue(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4096 &&
    value.trim() === value &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

function credentialJson(value: ConnectionCredential): string {
  return JSON.stringify({
    domain: value.domain,
    accessClientId: value.accessClientId,
    accessClientSecret: value.accessClientSecret,
  });
}

export function encodeConnectionCredential(value: ConnectionCredential): string {
  const credential = validateCredential(value);
  return `${tokenPrefix}${Buffer.from(credentialJson(credential), "utf8").toString("base64url")}`;
}

export function decodeConnectionCredential(token: string): ConnectionCredential {
  try {
    if (typeof token !== "string" || !token.startsWith(tokenPrefix)) throw invalidCredential();
    const encoded = token.slice(tokenPrefix.length);
    if (!base64UrlPattern.test(encoded) || encoded.length > 16_384) throw invalidCredential();
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) throw invalidCredential();
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const credential = validateCredential(JSON.parse(json));
    if (credentialJson(credential) !== json) throw invalidCredential();
    return credential;
  } catch {
    throw invalidCredential();
  }
}

function safeBasePath(value: string): string {
  if (value.includes("\0") || !isAbsolute(value)) throw new Error("invalid connection auth path");
  const normalized = normalize(value);
  const withoutTrailingSeparators = value.replace(/[\\/]+$/, "") || parsePath(value).root;
  if (normalized !== withoutTrailingSeparators || normalized === parsePath(normalized).root) {
    throw new Error("invalid connection auth path");
  }
  return normalized;
}

export function resolveConnectionAuthPath(dependencies: ConnectionDependencies = {}): string {
  const env = dependencies.env ?? process.env;
  const xdgDescriptor = Object.getOwnPropertyDescriptor(env, "XDG_CONFIG_HOME");
  const xdg =
    xdgDescriptor !== undefined &&
    "value" in xdgDescriptor &&
    typeof xdgDescriptor.value === "string"
      ? xdgDescriptor.value
      : undefined;
  const base =
    xdg === undefined || xdg === ""
      ? join(safeBasePath((dependencies.home ?? homedir)()), ".config")
      : safeBasePath(xdg);
  return join(base, "shlook", "auth.json");
}

export async function persistConnectionCredential(
  value: ConnectionCredential,
  dependencies: ConnectionDependencies = {},
): Promise<string> {
  const credential = validateCredential(value);
  const path = resolveConnectionAuthPath(dependencies);
  const fs = dependencies.fs ?? defaultFileSystem;
  const randomId = (dependencies.randomId ?? randomUUID)();
  if (!/^[A-Za-z0-9-]{1,64}$/.test(randomId))
    throw new Error("unable to persist connection credential");
  const directory = dirname(path);
  const temporaryPath = join(directory, `.auth.json.${randomId}`);

  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(temporaryPath, `${credentialJson(credential)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(temporaryPath, path);
    await fs.chmod(path, 0o600);
    return path;
  } catch {
    try {
      await fs.unlink(temporaryPath);
    } catch {
      // The temporary file may not have been created or may already have been renamed.
    }
    throw new Error("unable to persist connection credential");
  }
}

export async function loadConnectionCredential(
  dependencies: ConnectionDependencies = {},
): Promise<ConnectionCredential> {
  try {
    const path = resolveConnectionAuthPath(dependencies);
    const fs = dependencies.fs ?? defaultFileSystem;
    const uid = (dependencies.currentUid ?? (() => process.getuid?.()))();
    if (uid === undefined) throw new Error("current user is unavailable");
    const handle = await fs.open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.uid !== uid ||
        (stat.mode & 0o177) !== 0 ||
        stat.size > maximumCredentialFileBytes
      ) {
        throw new Error("unsafe connection credential file");
      }

      const bytes = Buffer.alloc(maximumCredentialFileBytes + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > maximumCredentialFileBytes) {
        throw new Error("connection credential file is too large");
      }
      const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
      return validateCredential(JSON.parse(json));
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error("unable to load connection credential");
  }
}
