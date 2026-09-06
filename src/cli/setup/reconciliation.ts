import { inspectSetup } from "./inspection.ts";
import type { CloudflareSetupDependencies, SetupDeploymentManifest, SetupInput } from "./model.ts";
import { exactOne, resourceKey } from "./shared.ts";

export async function reconcileSetupDeploymentManifest(
  input: SetupInput & { deploymentManifest: SetupDeploymentManifest },
  dependencies: CloudflareSetupDependencies,
): Promise<SetupDeploymentManifest> {
  const inspection = await inspectSetup(input, dependencies, true);
  const resources = { ...input.deploymentManifest.resources };
  for (const surface of ["owner", "private", "public", "share"] as const) {
    const key = resourceKey("workers_domain", surface);
    const hostname = new URL(inspection.normalized.origins[surface]).hostname;
    const existing = exactOne(
      inspection.state.workersDomains.filter((record) => record.hostname === hostname),
    );
    if (existing !== undefined) resources[key] = { ...resources[key], id: existing.id };
  }
  return { ...input.deploymentManifest, resources };
}
