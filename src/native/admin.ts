import { chmodSync, closeSync, constants, lstatSync, openSync, writeSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { realpathSync } from "node:fs";
import type { NativeStore, Role } from "./store.ts";

export const addUser = (store: NativeStore, id: string, displayName: string) =>
  store.addUser(id, displayName);
export const listUsers = (store: NativeStore) => store.listUsers();
export const disableUser = (store: NativeStore, id: string) => store.disableUser(id);
export function issueToken(
  store: NativeStore,
  userId: string,
  name: string,
  role: Role,
  expiresAt?: number | null,
  tokenFile?: string,
) {
  if (tokenFile) assertSafeNewTokenPath(tokenFile);
  const issued = store.issueToken({ userId, name, role, expiresAt });
  if (tokenFile) {
    try {
      const fd = openSync(
        tokenFile,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeSync(fd, `${issued.secret}\n`);
        closeSync(fd);
      } catch (error) {
        closeSync(fd);
        throw error;
      }
      chmodSync(tokenFile, 0o600);
    } catch (error) {
      store.revokeToken(issued.id);
      throw error;
    }
    return { id: issued.id, expiresAt: issued.expiresAt, tokenFile };
  }
  return issued;
}

function assertSafeNewTokenPath(path: string) {
  if (!isAbsolute(path)) throw new Error("token file path must be absolute");
  const absolute = resolve(path),
    parent = dirname(absolute);
  let cursor = "/";
  for (const component of parent.split("/").filter(Boolean)) {
    cursor = resolve(cursor, component);
    const stat = lstatSync(cursor);
    const trustedVarAlias =
      cursor === "/var" && stat.isSymbolicLink() && realpathSync(cursor) === "/private/var";
    if ((!stat.isDirectory() && !trustedVarAlias) || (stat.isSymbolicLink() && !trustedVarAlias))
      throw new Error("unsafe token file directory");
  }
  if (lstatSync(parent).uid !== process.getuid?.())
    throw new Error("token file directory is not owned by current user");
  try {
    lstatSync(absolute);
    throw new Error("token file already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
