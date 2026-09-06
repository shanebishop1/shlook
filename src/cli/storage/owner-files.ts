import { constants } from "node:fs";
import { dirname, isAbsolute, normalize, parse as parsePath } from "node:path";

export const OWNER_DIRECTORY_MODE = 0o700;
export const OWNER_FILE_MODE = 0o600;

export interface CanonicalPathFileSystem {
  realpath(path: string): Promise<string>;
}

export interface OwnerFileHandle {
  chmod(mode: number): Promise<void>;
  close(): Promise<void>;
}

export interface NoFollowOwnerFileSystem extends CanonicalPathFileSystem {
  open(path: string, flags: number): Promise<OwnerFileHandle>;
}

export interface AtomicOwnerFileSystem extends NoFollowOwnerFileSystem {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  chmod(path: string, mode: number): Promise<unknown>;
  writeFile(
    path: string,
    data: string,
    options: { encoding: "utf8"; flag: "wx"; mode: number },
  ): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  unlink(path: string): Promise<unknown>;
}

export function errorCode(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(cause, "code");
  return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}

export function safeAbsoluteBasePath(value: string, message: string): string {
  if (value.includes("\0") || !isAbsolute(value)) throw new Error(message);
  const normalized = normalize(value);
  const withoutTrailingSeparators = value.replace(/[\\/]+$/, "") || parsePath(value).root;
  if (normalized !== withoutTrailingSeparators || normalized === parsePath(normalized).root) {
    throw new Error(message);
  }
  return normalized;
}

export async function assertCanonicalPathComponents(
  path: string,
  fs: CanonicalPathFileSystem,
  unsafePathMessage: string,
): Promise<void> {
  const root = parsePath(path).root;
  let existingPath = path;
  for (;;) {
    try {
      if ((await fs.realpath(existingPath)) !== existingPath) throw new Error(unsafePathMessage);
      return;
    } catch (cause) {
      if (errorCode(cause) !== "ENOENT" || existingPath === root) throw cause;
      existingPath = dirname(existingPath);
    }
  }
}

export async function chmodOwnerFile(
  path: string,
  fs: NoFollowOwnerFileSystem,
  unsafePathMessage: string,
): Promise<void> {
  await assertCanonicalPathComponents(path, fs, unsafePathMessage);
  const handle = await fs.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    await handle.chmod(OWNER_FILE_MODE);
  } finally {
    await handle.close();
  }
}

export async function prepareOwnerDirectory(
  path: string,
  fs: Pick<AtomicOwnerFileSystem, "mkdir" | "realpath" | "chmod">,
  unsafePathMessage: string,
  enforceMode: boolean,
): Promise<void> {
  await fs.mkdir(path, { recursive: true, mode: OWNER_DIRECTORY_MODE });
  await assertCanonicalPathComponents(path, fs, unsafePathMessage);
  if (enforceMode) await fs.chmod(path, OWNER_DIRECTORY_MODE);
}

export interface AtomicReplaceOwnerFileOptions {
  path: string;
  temporaryPath: string;
  data: string | (() => string);
  fs: AtomicOwnerFileSystem;
  unsafePathMessage: string;
  enforceDirectoryMode: boolean;
  validateTemporaryPath: boolean;
  cleanup: "after-create" | "always-on-failure";
}

export async function atomicReplaceOwnerFile(
  options: AtomicReplaceOwnerFileOptions,
): Promise<void> {
  const directory = dirname(options.path);
  let created = false;
  try {
    await prepareOwnerDirectory(
      directory,
      options.fs,
      options.unsafePathMessage,
      options.enforceDirectoryMode,
    );
    if (options.validateTemporaryPath) {
      await assertCanonicalPathComponents(
        options.temporaryPath,
        options.fs,
        options.unsafePathMessage,
      );
    }
    const data = typeof options.data === "function" ? options.data() : options.data;
    await options.fs.writeFile(options.temporaryPath, data, {
      encoding: "utf8",
      flag: "wx",
      mode: OWNER_FILE_MODE,
    });
    created = true;
    await assertCanonicalPathComponents(options.path, options.fs, options.unsafePathMessage);
    await options.fs.rename(options.temporaryPath, options.path);
    created = false;
    await chmodOwnerFile(options.path, options.fs, options.unsafePathMessage);
  } catch (cause) {
    if (options.cleanup === "always-on-failure" || created) {
      await options.fs.unlink(options.temporaryPath).catch(() => undefined);
    }
    throw cause;
  }
}
