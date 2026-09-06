import { reconcileSetupDeploymentManifest, type SetupDeploymentManifest } from "../../cli-setup.ts";

import type { SetupRuntimeDependencies } from "./dependencies.ts";
import type { SetupRuntimeInput } from "./model.ts";
import { saveDeploymentManifest } from "./manifest.ts";

export async function reconcileManifest(
  input: SetupRuntimeInput,
  manifest: SetupDeploymentManifest,
  dependencies: SetupRuntimeDependencies,
): Promise<SetupDeploymentManifest> {
  const reconciled = await (
    dependencies.reconcileCloudflareSetup ?? reconcileSetupDeploymentManifest
  )(
    {
      domain: input.domain,
      ownerEmail: input.ownerEmail,
      ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
      deploymentManifest: manifest,
    },
    { env: dependencies.env, fetch: dependencies.fetch },
  );
  if (JSON.stringify(reconciled) !== JSON.stringify(manifest)) {
    await saveDeploymentManifest(reconciled, dependencies);
  }
  return reconciled;
}

export function unresolvedWorkerDomains(manifest: SetupDeploymentManifest): boolean {
  return (["owner", "private", "public", "share"] as const).some(
    (surface) => manifest.resources[`workers_domain_${surface}`].id === undefined,
  );
}
