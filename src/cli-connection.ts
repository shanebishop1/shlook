import { constants } from "node:fs";
import { chmod, mkdir, open, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  assertCanonicalPathComponents,
  atomicReplaceOwnerFile,
  safeAbsoluteBasePath,
} from "./cli/storage/owner-files.ts";

const tokenPrefix = "shlook_connect_v1_";
const credentialKeys = ["domain", "accessClientId", "accessClientSecret"] as const;
const originKeys = ["owner", "private", "public", "share"] as const;
const domainPattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const maximumCredentialFileBytes = 16_384;

export interface ConnectionCredential {
  domain: string;
  accessClientId: string;
  accessClientSecret: string;
  origins?: {
    owner: string;
    private: string;
    public: string;
    share: string;
  };
}

export interface ConnectionFileSystem {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  realpath(path: string): Promise<string>;
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
  chmod(mode: number): Promise<void>;
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
  realpath,
  writeFile,
  rename,
  chmod,
  open: async (path, flags) => open(path, flags),
  unlink,
};

function invalidCredential(): Error {
  return new Error("invalid connection credential");
}

export function assertConnectionCredentialStorageSupported(
  dependencies: Pick<ConnectionDependencies, "currentUid"> = {},
): number {
  const uid = (dependencies.currentUid ?? (() => process.getuid?.()))();
  if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 0) {
    throw new Error("local connection credential storage is unavailable");
  }
  return uid;
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
  if (
    (keys.length !== credentialKeys.length && keys.length !== credentialKeys.length + 1) ||
    credentialKeys.some((key) => !keys.includes(key)) ||
    (keys.length === credentialKeys.length + 1 && !keys.includes("origins"))
  ) {
    throw invalidCredential();
  }

  const domain = ownDataString(value, "domain");
  const accessClientId = ownDataString(value, "accessClientId");
  const accessClientSecret = ownDataString(value, "accessClientSecret");
  const originsDescriptor = Object.getOwnPropertyDescriptor(value, "origins");
  const originsValue =
    originsDescriptor !== undefined && "value" in originsDescriptor
      ? originsDescriptor.value
      : undefined;
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
  if (originsValue === undefined) return { domain, accessClientId, accessClientSecret };
  if (typeof originsValue !== "object" || originsValue === null || Array.isArray(originsValue)) {
    throw invalidCredential();
  }
  const originValueKeys = Object.keys(originsValue);
  if (
    originValueKeys.length !== originKeys.length ||
    originKeys.some((key) => !originValueKeys.includes(key))
  ) {
    throw invalidCredential();
  }
  const origins = Object.fromEntries(
    originKeys.map((key) => {
      const value = ownDataString(originsValue, key);
      if (value === undefined) throw invalidCredential();
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw invalidCredential();
      }
      if (
        url.protocol !== "https:" ||
        url.username !== "" ||
        url.password !== "" ||
        url.pathname !== "/" ||
        url.search !== "" ||
        url.hash !== ""
      ) {
        throw invalidCredential();
      }
      return [key, url.origin];
    }),
  ) as NonNullable<ConnectionCredential["origins"]>;
  if (new Set(Object.values(origins)).size !== originKeys.length) throw invalidCredential();
  return { domain, accessClientId, accessClientSecret, origins };
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
  const credential = validateCredential(value);
  return JSON.stringify({
    domain: credential.domain,
    accessClientId: credential.accessClientId,
    accessClientSecret: credential.accessClientSecret,
    ...(credential.origins === undefined ? {} : { origins: credential.origins }),
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
      ? join(
          safeAbsoluteBasePath((dependencies.home ?? homedir)(), "invalid connection auth path"),
          ".config",
        )
      : safeAbsoluteBasePath(xdg, "invalid connection auth path");
  return join(base, "shlook", "auth.json");
}

export async function persistConnectionCredential(
  value: ConnectionCredential,
  dependencies: ConnectionDependencies = {},
): Promise<string> {
  try {
    assertConnectionCredentialStorageSupported(dependencies);
    const credential = validateCredential(value);
    const path = resolveConnectionAuthPath(dependencies);
    const fs = dependencies.fs ?? defaultFileSystem;
    const randomId = (dependencies.randomId ?? randomUUID)();
    if (!/^[A-Za-z0-9-]{1,64}$/.test(randomId)) {
      throw new Error("invalid temporary credential path");
    }
    const directory = dirname(path);
    const temporaryPath = join(directory, `.auth.json.${randomId}`);

    await atomicReplaceOwnerFile({
      path,
      temporaryPath,
      data: () => `${credentialJson(credential)}\n`,
      fs,
      unsafePathMessage: "unsafe connection credential path",
      enforceDirectoryMode: false,
      validateTemporaryPath: false,
      cleanup: "always-on-failure",
    });
    return path;
  } catch {
    throw new Error("unable to persist connection credential");
  }
}

export async function loadConnectionCredential(
  dependencies: ConnectionDependencies = {},
): Promise<ConnectionCredential> {
  try {
    const uid = assertConnectionCredentialStorageSupported(dependencies);
    const path = resolveConnectionAuthPath(dependencies);
    const fs = dependencies.fs ?? defaultFileSystem;
    await assertCanonicalPathComponents(path, fs, "unsafe connection credential path");
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
