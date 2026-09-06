import type { SetupDeploymentManifest, SetupResourceKey } from "../../cli-setup.ts";

import type { SetupRuntimeDependencies } from "./dependencies.ts";
import { manifestStorageFailure } from "./errors.ts";
import { setupRuntimeFileSystem } from "./filesystem.ts";
import { DEPLOYMENT_MANIFEST_FILE, setupStatePath } from "./paths.ts";
import { atomicCreateOwnerFile, atomicWriteOwnerFile, readOwnerFile } from "./state-files.ts";

const setupResourceKeys: SetupResourceKey[] = [
  "d1",
  "r2",
  "access_application_owner",
  "access_application_private",
  "access_service_token",
  "access_email_policy_owner",
  "access_email_policy_private",
  "access_service_token_policy_owner",
  "access_service_token_policy_private",
  "worker_service",
  "workers_domain_owner",
  "workers_domain_private",
  "workers_domain_public",
  "workers_domain_share",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifest(raw: string): SetupDeploymentManifest {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw manifestStorageFailure();
  }
  if (
    !isRecord(decoded) ||
    Object.keys(decoded).length !== 6 ||
    decoded.version !== 1 ||
    typeof decoded.domain !== "string" ||
    typeof decoded.ownerEmail !== "string" ||
    typeof decoded.accountId !== "string" ||
    typeof decoded.zoneId !== "string" ||
    !isRecord(decoded.resources) ||
    Object.keys(decoded.resources).length !== setupResourceKeys.length
  ) {
    throw manifestStorageFailure();
  }
  for (const key of setupResourceKeys) {
    const value = decoded.resources[key];
    if (
      !isRecord(value) ||
      ![2, 3].includes(Object.keys(value).length) ||
      Object.keys(value).some((field) => !["action", "name", "id"].includes(field)) ||
      !["create", "adopt"].includes(String(value.action)) ||
      typeof value.name !== "string" ||
      value.name.length === 0 ||
      value.name.length > 4096 ||
      (value.id !== undefined &&
        (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 4096))
    ) {
      throw manifestStorageFailure();
    }
  }
  return decoded as unknown as SetupDeploymentManifest;
}

export async function loadDeploymentManifest(
  dependencies: SetupRuntimeDependencies,
): Promise<SetupDeploymentManifest | undefined> {
  const raw = await readOwnerFile(
    setupStatePath(dependencies, DEPLOYMENT_MANIFEST_FILE),
    setupRuntimeFileSystem(dependencies),
    manifestStorageFailure,
  );
  return raw === undefined ? undefined : parseManifest(raw);
}

export async function saveDeploymentManifest(
  manifest: SetupDeploymentManifest,
  dependencies: SetupRuntimeDependencies,
  createOnly = false,
): Promise<void> {
  await (createOnly ? atomicCreateOwnerFile : atomicWriteOwnerFile)(
    setupStatePath(dependencies, DEPLOYMENT_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    dependencies,
    manifestStorageFailure,
  );
}
