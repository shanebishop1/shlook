import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { safeAbsoluteBasePath } from "../storage/owner-files.ts";

import type { SetupRuntimeDependencies } from "./dependencies.ts";
import { manifestStorageFailure, pendingCredentialsFailure } from "./errors.ts";

export const DEPLOYMENT_SECRET_FILE = "secret-encryption-key";
export const DEPLOYMENT_MANIFEST_FILE = "manifest.json";
export const PENDING_SERVICE_TOKEN_FILE = "pending-service-token.json";
export const SERVICE_TOKEN_ROTATION_FILE = "service-token-rotation.json";

export function resolveSetupConfigPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: () => string = homedir,
): string {
  const descriptor = Object.getOwnPropertyDescriptor(env, "XDG_CONFIG_HOME");
  const xdg =
    descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  const invalidPath = "invalid setup configuration path";
  const base =
    xdg === undefined || xdg === ""
      ? join(safeAbsoluteBasePath(home(), invalidPath), ".config")
      : safeAbsoluteBasePath(xdg, invalidPath);
  return join(base, "shlook", "deployment", "wrangler.json");
}

export function setupStatePath(dependencies: SetupRuntimeDependencies, file: string): string {
  try {
    return join(dirname(resolveSetupConfigPath(dependencies.env, dependencies.home)), file);
  } catch {
    throw file === DEPLOYMENT_MANIFEST_FILE
      ? manifestStorageFailure()
      : pendingCredentialsFailure();
  }
}
