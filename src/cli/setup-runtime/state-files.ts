import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { dirname, join } from "node:path";

import {
  OWNER_FILE_MODE,
  assertCanonicalPathComponents,
  atomicReplaceOwnerFile,
  chmodOwnerFile,
  errorCode,
  prepareOwnerDirectory,
} from "../storage/owner-files.ts";

import type {
  SetupRuntimeDependencies,
  SetupRuntimeFileHandle,
  SetupRuntimeFileSystem,
} from "./dependencies.ts";
import { SetupRuntimeError } from "./errors.ts";
import { setupRuntimeFileSystem } from "./filesystem.ts";

const MAX_STATE_BYTES = 65_536;
const UNSAFE_SETUP_STATE_PATH = "unsafe setup state path";

export function validTemporaryId(dependencies: SetupRuntimeDependencies): string | undefined {
  const id = (dependencies.randomId ?? randomUUID)();
  return /^[A-Za-z0-9-]{1,64}$/.test(id) ? id : undefined;
}

export async function readOwnerFile(
  path: string,
  fs: SetupRuntimeFileSystem,
  failure: () => SetupRuntimeError,
): Promise<string | undefined> {
  let handle: SetupRuntimeFileHandle;
  try {
    await assertCanonicalPathComponents(path, fs, UNSAFE_SETUP_STATE_PATH);
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return undefined;
    throw failure();
  }
  try {
    const metadata = await handle.stat();
    const currentUid = process.getuid?.();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o777) !== OWNER_FILE_MODE ||
      metadata.size <= 0 ||
      metadata.size > MAX_STATE_BYTES ||
      (currentUid !== undefined && metadata.uid !== currentUid)
    ) {
      throw failure();
    }
    return await handle.readFile({ encoding: "utf8" });
  } catch (cause) {
    if (cause instanceof SetupRuntimeError) throw cause;
    throw failure();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function atomicWriteOwnerFile(
  path: string,
  data: string,
  dependencies: SetupRuntimeDependencies,
  failure: () => SetupRuntimeError,
): Promise<void> {
  const id = validTemporaryId(dependencies);
  if (id === undefined) throw failure();
  const temporaryPath = join(dirname(path), `.${path.slice(path.lastIndexOf("/") + 1)}.${id}`);
  try {
    await atomicReplaceOwnerFile({
      path,
      temporaryPath,
      data,
      fs: setupRuntimeFileSystem(dependencies),
      unsafePathMessage: UNSAFE_SETUP_STATE_PATH,
      enforceDirectoryMode: true,
      validateTemporaryPath: true,
      cleanup: "after-create",
    });
  } catch {
    throw failure();
  }
}

export async function atomicCreateOwnerFile(
  path: string,
  data: string,
  dependencies: SetupRuntimeDependencies,
  failure: () => SetupRuntimeError,
): Promise<void> {
  const fs = setupRuntimeFileSystem(dependencies);
  const directory = dirname(path);
  const id = validTemporaryId(dependencies);
  if (id === undefined) throw failure();
  const temporaryPath = join(directory, `.${path.slice(path.lastIndexOf("/") + 1)}.${id}`);
  let created = false;
  try {
    await prepareOwnerDirectory(directory, fs, UNSAFE_SETUP_STATE_PATH, true);
    await assertCanonicalPathComponents(temporaryPath, fs, UNSAFE_SETUP_STATE_PATH);
    await fs.writeFile(temporaryPath, data, {
      encoding: "utf8",
      flag: "wx",
      mode: OWNER_FILE_MODE,
    });
    created = true;
    try {
      await assertCanonicalPathComponents(path, fs, UNSAFE_SETUP_STATE_PATH);
      await fs.link(temporaryPath, path);
    } catch (cause) {
      if (errorCode(cause) !== "EEXIST") throw cause;
      const winner = await readOwnerFile(path, fs, failure);
      if (winner !== data) throw failure();
      return;
    }
    await chmodOwnerFile(path, fs, UNSAFE_SETUP_STATE_PATH);
  } catch (cause) {
    if (cause instanceof SetupRuntimeError) throw cause;
    throw failure();
  } finally {
    if (created) await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

export async function removeOwnerFile(
  path: string,
  dependencies: SetupRuntimeDependencies,
  failure: () => SetupRuntimeError,
): Promise<void> {
  const fs = setupRuntimeFileSystem(dependencies);
  try {
    await assertCanonicalPathComponents(path, fs, UNSAFE_SETUP_STATE_PATH);
    await fs.unlink(path);
  } catch (cause) {
    if (errorCode(cause) !== "ENOENT") throw failure();
  }
}

export { UNSAFE_SETUP_STATE_PATH };
