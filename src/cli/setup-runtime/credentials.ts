import type { ConnectionCredential } from "../../cli-connection.ts";

import type { SetupRuntimeDependencies } from "./dependencies.ts";
import { SetupRuntimeError } from "./errors.ts";

export async function storedCredential(
  dependencies: SetupRuntimeDependencies,
): Promise<ConnectionCredential | undefined> {
  if (dependencies.loadConnection === undefined) return undefined;
  try {
    return await dependencies.loadConnection();
  } catch {
    return undefined;
  }
}

export function sameCredential(left: ConnectionCredential, right: ConnectionCredential): boolean {
  return (
    left.domain === right.domain &&
    left.accessClientId === right.accessClientId &&
    left.accessClientSecret === right.accessClientSecret
  );
}

export async function verifiedPersistedConnection(
  credential: ConnectionCredential,
  dependencies: SetupRuntimeDependencies,
): Promise<string> {
  let path: string;
  try {
    path = await dependencies.persistConnection(credential);
    if (dependencies.loadConnection === undefined) throw new Error("connection loader unavailable");
    const loaded = await dependencies.loadConnection();
    if (!sameCredential(loaded, credential)) throw new Error("persisted credential mismatch");
  } catch {
    throw new SetupRuntimeError(
      "connection_persistence_failed",
      "unable to save and verify connection credential",
    );
  }
  return path;
}
