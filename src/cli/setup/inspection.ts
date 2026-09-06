import { CloudflareApiClient } from "./api.ts";
import { probe, resolveAccount, resolveZone, verifyToken } from "./discovery-core.ts";
import {
  inspectApplications,
  inspectD1,
  inspectPolicies,
  inspectR2,
  inspectServiceToken,
  inspectWorkersDomains,
  inspectWorkerService,
} from "./discovery-resources.ts";
import {
  type CloudflareSetupDependencies,
  type ExistingState,
  type NormalizedSetupInput,
  type SetupCapabilities,
  type SetupCapability,
  type SetupInput,
  type SetupPlan,
} from "./model.ts";
import { buildDeploymentManifest, buildSetupActions } from "./plan.ts";
import { normalizeInput, validateDeploymentOwnership } from "./validation.ts";

export interface Inspection {
  plan: SetupPlan;
  state: ExistingState;
  normalized: NormalizedSetupInput;
  client: CloudflareApiClient;
}

export async function inspectSetup(
  input: SetupInput,
  dependencies: CloudflareSetupDependencies,
  discoverCreatedWorkersResources = false,
): Promise<Inspection> {
  const normalized = normalizeInput(input);
  const client = new CloudflareApiClient(dependencies);
  await verifyToken(client);
  const account = await resolveAccount(client, normalized.accountId);
  const zone = await resolveZone(client, account.id, normalized.domain);

  const [d1Probe, r2Probe, appsProbe, serviceTokenProbe, workersServiceProbe, workersDomainsProbe] =
    await Promise.all([
      probe(() => inspectD1(client, account.id)),
      probe(() => inspectR2(client, account.id)),
      probe(() => inspectApplications(client, account.id, normalized.origins)),
      probe(() => inspectServiceToken(client, account.id)),
      probe(() => inspectWorkerService(client, account.id)),
      probe(() => inspectWorkersDomains(client, account.id, zone.id, normalized.origins)),
    ]);

  const accessApplications: ExistingState["accessApplications"] = appsProbe.value ?? {};
  const accessServiceToken = serviceTokenProbe.value;
  const accessPolicies: ExistingState["accessPolicies"] = {};
  let policiesCapability: SetupCapability = { status: "available" };
  if (appsProbe.capability.status === "available") {
    const policyProbes = await Promise.all(
      (["owner", "private"] as const).map(async (surface) => {
        const app = accessApplications[surface];
        if (app === undefined) return { surface, probe: undefined };
        return {
          surface,
          probe: await probe(() =>
            inspectPolicies(
              client,
              account.id,
              app.id,
              normalized.ownerEmail,
              accessServiceToken?.id,
            ),
          ),
        };
      }),
    );
    for (const current of policyProbes) {
      if (current.probe === undefined) continue;
      if (current.probe.capability.status !== "available") {
        policiesCapability = current.probe.capability;
      } else if (current.probe.value !== undefined) {
        accessPolicies[current.surface] = current.probe.value;
      }
    }
  } else {
    policiesCapability = appsProbe.capability;
  }

  const capabilities: SetupCapabilities = {
    tokenVerification: { status: "available" },
    memberships: { status: "available" },
    zones: { status: "available" },
    d1: d1Probe.capability,
    r2: r2Probe.capability,
    accessApplications: appsProbe.capability,
    accessPolicies: policiesCapability,
    accessServiceTokens: serviceTokenProbe.capability,
    workersServices: workersServiceProbe.capability,
    workersDomains: workersDomainsProbe.capability,
  };
  const state: ExistingState = {
    d1: d1Probe.value,
    r2: r2Probe.value,
    accessApplications,
    accessPolicies,
    accessServiceToken,
    workerService: workersServiceProbe.value,
    workersDomains: workersDomainsProbe.value ?? [],
  };
  validateDeploymentOwnership(
    input,
    normalized,
    account,
    zone,
    state,
    discoverCreatedWorkersResources,
  );
  const deploymentManifest = buildDeploymentManifest(input, normalized, account, zone, state);
  const actions = buildSetupActions(input, normalized, capabilities, state);

  return {
    client,
    normalized,
    state,
    plan: {
      mode: "plan",
      ready:
        Object.values(capabilities).every((capability) => capability.status === "available") &&
        actions.every((action) => action.operation !== "blocked"),
      account,
      zone,
      origins: normalized.origins,
      capabilities,
      actions,
      deploymentManifest,
    },
  };
}

export async function planSetup(
  input: SetupInput,
  dependencies: CloudflareSetupDependencies,
): Promise<SetupPlan> {
  return (await inspectSetup(input, dependencies)).plan;
}
