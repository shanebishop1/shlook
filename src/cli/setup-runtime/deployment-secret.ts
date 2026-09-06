import { randomBytes as nodeRandomBytes } from "node:crypto";
import { constants } from "node:fs";
import { dirname, join } from "node:path";

import {
  OWNER_FILE_MODE,
  assertCanonicalPathComponents,
  chmodOwnerFile,
  errorCode,
  prepareOwnerDirectory,
} from "../storage/owner-files.ts";

import type {
  SetupRuntimeDependencies,
  SetupRuntimeFileHandle,
  SetupRuntimeFileSystem,
} from "./dependencies.ts";
import { secretStorageFailure, SetupRuntimeError } from "./errors.ts";
import { setupRuntimeFileSystem } from "./filesystem.ts";
import { DEPLOYMENT_SECRET_FILE, resolveSetupConfigPath } from "./paths.ts";
import { UNSAFE_SETUP_STATE_PATH, validTemporaryId } from "./state-files.ts";

function validateDeploymentSecret(raw: string): string {
  const value = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (
    !/^[A-Za-z0-9+/]{43}=$/.test(value) ||
    Buffer.from(value, "base64").byteLength !== 32 ||
    Buffer.from(value, "base64").toString("base64") !== value ||
    (raw !== value && raw !== `${value}\n`)
  ) {
    throw secretStorageFailure();
  }
  return value;
}

async function loadDeploymentSecret(
  path: string,
  fs: SetupRuntimeFileSystem,
): Promise<string | undefined> {
  let handle: SetupRuntimeFileHandle;
  try {
    await assertCanonicalPathComponents(path, fs, UNSAFE_SETUP_STATE_PATH);
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return undefined;
    throw secretStorageFailure();
  }

  let value: string;
  try {
    const metadata = await handle.stat();
    const currentUid = process.getuid?.();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o777) !== OWNER_FILE_MODE ||
      ![44, 45].includes(metadata.size) ||
      (currentUid !== undefined && metadata.uid !== currentUid)
    ) {
      throw secretStorageFailure();
    }
    value = validateDeploymentSecret(await handle.readFile({ encoding: "utf8" }));
  } catch (cause) {
    await handle.close().catch(() => undefined);
    if (cause instanceof SetupRuntimeError) throw cause;
    throw secretStorageFailure();
  }
  try {
    await handle.close();
  } catch {
    throw secretStorageFailure();
  }
  return value;
}

async function deploymentConfigExists(path: string, fs: SetupRuntimeFileSystem): Promise<boolean> {
  let handle: SetupRuntimeFileHandle;
  try {
    await assertCanonicalPathComponents(path, fs, UNSAFE_SETUP_STATE_PATH);
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return false;
    throw secretStorageFailure();
  }
  try {
    if (!(await handle.stat()).isFile()) throw secretStorageFailure();
  } catch (cause) {
    await handle.close().catch(() => undefined);
    if (cause instanceof SetupRuntimeError) throw cause;
    throw secretStorageFailure();
  }
  try {
    await handle.close();
  } catch {
    throw secretStorageFailure();
  }
  return true;
}

function generateDeploymentSecret(dependencies: SetupRuntimeDependencies): string {
  let bytes: Uint8Array;
  try {
    bytes = (dependencies.randomBytes ?? nodeRandomBytes)(32);
  } catch {
    throw new SetupRuntimeError(
      "setup_secret_generation_failed",
      "unable to generate the encryption secret",
    );
  }
  if (bytes.byteLength !== 32) {
    throw new SetupRuntimeError(
      "setup_secret_generation_failed",
      "unable to generate the encryption secret",
    );
  }
  return Buffer.from(bytes).toString("base64");
}

export async function loadOrCreateDeploymentSecret(
  dependencies: SetupRuntimeDependencies,
  allowCreate = true,
): Promise<string> {
  let configPath: string;
  try {
    configPath = resolveSetupConfigPath(dependencies.env, dependencies.home);
  } catch {
    throw secretStorageFailure();
  }
  const path = join(dirname(configPath), DEPLOYMENT_SECRET_FILE);
  const directory = dirname(path);
  const fs = setupRuntimeFileSystem(dependencies);
  try {
    await prepareOwnerDirectory(directory, fs, UNSAFE_SETUP_STATE_PATH, true);
  } catch {
    throw secretStorageFailure();
  }

  const existing = await loadDeploymentSecret(path, fs);
  if (existing !== undefined) return existing;
  if (!allowCreate || (await deploymentConfigExists(configPath, fs))) throw secretStorageFailure();

  const secret = generateDeploymentSecret(dependencies);
  const id = validTemporaryId(dependencies);
  if (id === undefined) throw secretStorageFailure();
  const temporaryPath = join(directory, `.${DEPLOYMENT_SECRET_FILE}.${id}`);
  let temporaryCreated = false;
  try {
    await assertCanonicalPathComponents(temporaryPath, fs, UNSAFE_SETUP_STATE_PATH);
    await fs.writeFile(temporaryPath, `${secret}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: OWNER_FILE_MODE,
    });
    temporaryCreated = true;
    try {
      await assertCanonicalPathComponents(path, fs, UNSAFE_SETUP_STATE_PATH);
      await fs.link(temporaryPath, path);
    } catch (cause) {
      if (errorCode(cause) !== "EEXIST") throw cause;
      const winner = await loadDeploymentSecret(path, fs);
      if (winner === undefined) throw secretStorageFailure();
      return winner;
    }
    await chmodOwnerFile(path, fs, UNSAFE_SETUP_STATE_PATH);
    return secret;
  } catch (cause) {
    if (cause instanceof SetupRuntimeError) throw cause;
    throw secretStorageFailure();
  } finally {
    if (temporaryCreated) {
      try {
        await fs.unlink(temporaryPath);
      } catch {
        // The owner-only directory contains a random, non-authoritative hard link at worst.
      }
    }
  }
}
