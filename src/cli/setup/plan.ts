import {
  CLOUDFLARE_SETUP_NAMES,
  type ExistingState,
  type NormalizedSetupInput,
  type SetupAccount,
  type SetupAction,
  type SetupCapabilities,
  type SetupCapability,
  type SetupDeploymentManifest,
  type SetupInput,
  type SetupResourceIntent,
  type SetupResourceKey,
  type SetupZone,
} from "./model.ts";
import { exactOne, resourceKey } from "./shared.ts";

function intent(
  input: SetupInput,
  name: string,
  existing?: { id: string },
  deterministicCreateId?: string,
): SetupResourceIntent {
  if (input.deploymentManifest !== undefined) {
    throw new Error("existing manifest intents must be reused");
  }
  return {
    action: existing === undefined ? "create" : "adopt",
    name,
    ...(existing === undefined
      ? deterministicCreateId === undefined
        ? {}
        : { id: deterministicCreateId }
      : { id: existing.id }),
  };
}

export function buildDeploymentManifest(
  input: SetupInput,
  normalized: NormalizedSetupInput,
  account: SetupAccount,
  zone: SetupZone,
  state: ExistingState,
): SetupDeploymentManifest {
  if (input.deploymentManifest !== undefined) return input.deploymentManifest;
  const resources = {} as Record<SetupResourceKey, SetupResourceIntent>;
  resources.d1 = intent(input, CLOUDFLARE_SETUP_NAMES.d1, state.d1);
  resources.r2 = intent(
    input,
    CLOUDFLARE_SETUP_NAMES.r2,
    state.r2 === undefined ? undefined : { id: state.r2.name },
    CLOUDFLARE_SETUP_NAMES.r2,
  );
  for (const surface of ["owner", "private"] as const) {
    resources[resourceKey("access_application", surface)] = intent(
      input,
      CLOUDFLARE_SETUP_NAMES.accessApplications[surface],
      state.accessApplications[surface],
    );
    resources[resourceKey("access_email_policy", surface)] = intent(
      input,
      CLOUDFLARE_SETUP_NAMES.accessPolicies.email,
      state.accessPolicies[surface]?.email,
    );
    resources[resourceKey("access_service_token_policy", surface)] = intent(
      input,
      CLOUDFLARE_SETUP_NAMES.accessPolicies.serviceToken,
      state.accessPolicies[surface]?.serviceToken,
    );
  }
  resources.access_service_token = intent(
    input,
    CLOUDFLARE_SETUP_NAMES.accessServiceToken,
    state.accessServiceToken,
  );
  resources.worker_service = intent(input, "shlook", state.workerService, "shlook");
  for (const surface of ["owner", "private", "public", "share"] as const) {
    const hostname = new URL(normalized.origins[surface]).hostname;
    const matches = state.workersDomains.filter((record) => record.hostname === hostname);
    const existing = exactOne(matches);
    resources[resourceKey("workers_domain", surface)] = intent(input, hostname, existing);
  }
  return {
    version: 1,
    domain: normalized.domain,
    ownerEmail: normalized.ownerEmail,
    accountId: account.id,
    zoneId: zone.id,
    resources,
  };
}

function blockedOperation(capability: SetupCapability): "blocked" | "create" {
  return capability.status === "available" ? "create" : "blocked";
}

function resourceAction(
  resource: "d1" | "r2" | "access_service_token",
  name: string,
  capability: SetupCapability,
  input: SetupInput,
  existing?: { id?: string; name?: string },
): SetupAction {
  if (existing !== undefined)
    return {
      resource,
      operation: input.deploymentManifest === undefined ? "adopt" : "reuse",
      name,
      id: existing.id,
    };
  const operation = blockedOperation(capability);
  return {
    resource,
    operation,
    name,
    ...(operation === "blocked" ? { reason: "capability_unavailable" as const } : {}),
  };
}

export function buildSetupActions(
  input: SetupInput,
  normalized: NormalizedSetupInput,
  capabilities: SetupCapabilities,
  state: ExistingState,
): SetupAction[] {
  const actions: SetupAction[] = [
    resourceAction("d1", CLOUDFLARE_SETUP_NAMES.d1, capabilities.d1, input, state.d1),
    resourceAction("r2", CLOUDFLARE_SETUP_NAMES.r2, capabilities.r2, input, state.r2),
  ];
  for (const surface of ["owner", "private"] as const) {
    const app = state.accessApplications[surface];
    const hostname = new URL(normalized.origins[surface]).hostname;
    const appOperation =
      app === undefined
        ? blockedOperation(capabilities.accessApplications)
        : input.deploymentManifest === undefined
          ? "adopt"
          : "reuse";
    actions.push({
      resource: "access_application",
      operation: appOperation,
      name: CLOUDFLARE_SETUP_NAMES.accessApplications[surface],
      surface,
      hostname,
      ...(app === undefined ? {} : { id: app.id }),
      ...(appOperation === "blocked" ? { reason: "capability_unavailable" } : {}),
    });
  }
  actions.push(
    state.accessServiceToken?.nearExpiry === true && input.deploymentManifest === undefined
      ? {
          resource: "access_service_token",
          operation: "blocked",
          name: CLOUDFLARE_SETUP_NAMES.accessServiceToken,
          id: state.accessServiceToken.id,
          reason: "service_token_expiring",
        }
      : state.accessServiceToken?.nearExpiry === true
        ? {
            resource: "access_service_token",
            operation: "renew",
            name: CLOUDFLARE_SETUP_NAMES.accessServiceToken,
            id: state.accessServiceToken.id,
            reason: "service_token_expiring",
          }
        : resourceAction(
            "access_service_token",
            CLOUDFLARE_SETUP_NAMES.accessServiceToken,
            capabilities.accessServiceTokens,
            input,
            state.accessServiceToken,
          ),
  );
  for (const surface of ["owner", "private"] as const) {
    const policies = state.accessPolicies[surface];
    for (const kind of ["email", "serviceToken"] as const) {
      const existing = policies?.[kind];
      const operation =
        existing === undefined
          ? blockedOperation(capabilities.accessPolicies)
          : input.deploymentManifest === undefined
            ? "adopt"
            : "reuse";
      actions.push({
        resource: kind === "email" ? "access_email_policy" : "access_service_token_policy",
        operation,
        name: CLOUDFLARE_SETUP_NAMES.accessPolicies[kind],
        surface,
        ...(existing === undefined ? {} : { id: existing.id }),
        ...(operation === "blocked" ? { reason: "capability_unavailable" } : {}),
      });
    }
  }
  actions.push({
    resource: "worker_service",
    operation:
      state.workerService === undefined
        ? blockedOperation(capabilities.workersServices)
        : input.deploymentManifest === undefined
          ? "adopt"
          : "reuse",
    name: "shlook",
    ...(state.workerService === undefined ? {} : { id: state.workerService.id }),
    ...(state.workerService === undefined && capabilities.workersServices.status !== "available"
      ? { reason: "capability_unavailable" }
      : {}),
  });
  actions.push({
    resource: "workers_domains",
    operation: "controller",
    name: "shlook custom domains",
    hostnames: Object.values(normalized.origins).map((origin) => new URL(origin).hostname),
    reason: "controller_owned",
  });
  return actions;
}
