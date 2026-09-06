import { planSetup, type SetupInput, type SetupPlan } from "../../cli-setup.ts";

import type { SetupRuntimeDependencies } from "./dependencies.ts";
import { loadDeploymentManifest } from "./manifest.ts";

export async function planSetupRuntime(
  input: SetupInput,
  dependencies: SetupRuntimeDependencies,
): Promise<SetupPlan> {
  const deploymentManifest = await loadDeploymentManifest(dependencies);
  return (dependencies.planCloudflareSetup ?? planSetup)(
    {
      domain: input.domain,
      ownerEmail: input.ownerEmail,
      ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
      ...(input.adoptExisting === true ? { adoptExisting: true } : {}),
      ...(deploymentManifest === undefined ? {} : { deploymentManifest }),
    },
    {
      env: dependencies.env,
      fetch: dependencies.fetch,
    },
  );
}
