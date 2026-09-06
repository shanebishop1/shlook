import { link, mkdir, open, realpath, rename, unlink, writeFile, chmod } from "node:fs/promises";

import type { SetupRuntimeFileSystem } from "./dependencies.ts";

export const defaultSetupRuntimeFileSystem: SetupRuntimeFileSystem = {
  mkdir,
  realpath,
  chmod,
  writeFile,
  rename,
  unlink,
  link,
  open,
};

export function setupRuntimeFileSystem(dependencies: {
  fs?: SetupRuntimeFileSystem;
}): SetupRuntimeFileSystem {
  return dependencies.fs ?? defaultSetupRuntimeFileSystem;
}
