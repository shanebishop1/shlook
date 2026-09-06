import { inspectSetup } from "./inspection.ts";
import {
  CLOUDFLARE_SETUP_NAMES,
  CloudflareSetupError,
  type AppliedAccessApplication,
  type AppliedResource,
  type AppliedServiceToken,
  type ApplySetupInput,
  type ApplySetupResult,
  type CloudflareSetupDependencies,
  type CreatedServiceTokenCredentials,
  type SetupSurface,
} from "./model.ts";
import {
  createApplication,
  createD1,
  createPolicy,
  createR2,
  createServiceToken,
  persistSetupState,
  rotateServiceToken,
  updateServiceTokenDuration,
} from "./mutations.ts";
import { manifestMismatch, resourceKey } from "./shared.ts";
import { interruptedResourceCreate, validateExistingCredentials } from "./validation.ts";

export async function applySetup(
  input: ApplySetupInput,
  dependencies: CloudflareSetupDependencies,
): Promise<ApplySetupResult> {
  validateExistingCredentials(input.existingServiceToken);
  const inspection = await inspectSetup(input, dependencies);
  const { client, normalized, plan, state } = inspection;
  if (!plan.ready) {
    throw new CloudflareSetupError(
      "setup_capabilities_unavailable",
      "required Cloudflare setup capabilities are unavailable",
    );
  }
  const persistence = input.persistence;
  if (persistence === undefined) {
    throw new CloudflareSetupError(
      "setup_state_persistence_required",
      "transactional shlook setup persistence is required before Cloudflare mutations",
    );
  }

  const serviceTokenIntent = input.deploymentManifest?.resources.access_service_token;
  const interruptedCreate =
    state.accessServiceToken !== undefined &&
    serviceTokenIntent?.action === "create" &&
    serviceTokenIntent.id === undefined &&
    Object.keys(serviceTokenIntent).length === 2;
  const rotationRecovery = input.serviceTokenRotationPending === true;
  const rotationCompleted = input.serviceTokenRotationCompleted === true;
  if (rotationRecovery && rotationCompleted) manifestMismatch();
  if (
    rotationRecovery &&
    (state.accessServiceToken === undefined ||
      serviceTokenIntent === undefined ||
      serviceTokenIntent.id !== state.accessServiceToken.id)
  ) {
    manifestMismatch();
  }
  if (
    rotationCompleted &&
    (state.accessServiceToken === undefined ||
      serviceTokenIntent === undefined ||
      serviceTokenIntent.id !== state.accessServiceToken.id ||
      input.existingServiceToken === undefined ||
      input.existingServiceToken.clientId !== state.accessServiceToken.clientId)
  ) {
    manifestMismatch();
  }
  const renewal =
    state.accessServiceToken?.nearExpiry === true &&
    serviceTokenIntent?.id === state.accessServiceToken.id &&
    !rotationCompleted;
  const ownedCreateSecretRecovery =
    state.accessServiceToken !== undefined &&
    serviceTokenIntent?.action === "create" &&
    serviceTokenIntent.id === state.accessServiceToken.id &&
    input.existingServiceToken === undefined;
  const willRotateServiceToken =
    interruptedCreate || rotationRecovery || renewal || ownedCreateSecretRecovery;

  if (state.accessServiceToken !== undefined) {
    if (input.existingServiceToken === undefined && !willRotateServiceToken) {
      throw new CloudflareSetupError(
        "service_token_secret_unavailable",
        "the existing shlook Access service token secret cannot be recovered",
      );
    }
    if (
      input.existingServiceToken !== undefined &&
      input.existingServiceToken.clientId !== state.accessServiceToken.clientId
    ) {
      throw new CloudflareSetupError(
        "service_token_credentials_conflict",
        "existing Access service token credentials do not match Cloudflare",
      );
    }
  } else if (input.existingServiceToken !== undefined) {
    throw new CloudflareSetupError(
      "service_token_credentials_conflict",
      "existing Access service token credentials do not match Cloudflare",
    );
  }

  await persistSetupState(() => persistence.saveIntent(plan.deploymentManifest));

  const accountId = plan.account.id;
  const d1: AppliedResource =
    state.d1 === undefined ? await createD1(client, accountId) : { ...state.d1, created: false };
  if (d1.created || interruptedResourceCreate(input, "d1")) {
    await persistSetupState(() => persistence.saveResource("d1", d1.id));
  }
  const r2: AppliedResource =
    state.r2 === undefined
      ? await createR2(client, accountId)
      : { id: state.r2.name, name: state.r2.name, created: false };
  if (r2.created || interruptedResourceCreate(input, "r2")) {
    await persistSetupState(() => persistence.saveResource("r2", r2.id));
  }

  const accessApplications = {} as Record<SetupSurface, AppliedAccessApplication>;
  for (const surface of ["owner", "private"] as const) {
    const existing = state.accessApplications[surface];
    accessApplications[surface] =
      existing === undefined
        ? await createApplication(client, accountId, surface, normalized.origins[surface])
        : { ...existing, created: false };
    const applicationKey = resourceKey("access_application", surface);
    if (accessApplications[surface].created || interruptedResourceCreate(input, applicationKey)) {
      await persistSetupState(() =>
        persistence.saveResource(applicationKey, accessApplications[surface].id),
      );
    }
  }

  let accessServiceToken: AppliedServiceToken;
  let createdServiceTokenCredentials: CreatedServiceTokenCredentials | undefined;
  if (state.accessServiceToken === undefined) {
    const created = await createServiceToken(client, accountId, (token) =>
      persistence.saveServiceToken(token),
    );
    accessServiceToken = created.resource;
    createdServiceTokenCredentials = created.credentials;
    await persistSetupState(() =>
      persistence.saveResource("access_service_token", accessServiceToken.id),
    );
  } else if (willRotateServiceToken) {
    if (interruptedCreate) {
      await persistSetupState(() =>
        persistence.saveResource("access_service_token", state.accessServiceToken!.id),
      );
    }
    await persistSetupState(() =>
      persistence.beginServiceTokenRotation(
        state.accessServiceToken!.id,
        state.accessServiceToken!.clientId,
      ),
    );
    if (renewal) await updateServiceTokenDuration(client, accountId, state.accessServiceToken);
    const rotated = await rotateServiceToken(client, accountId, state.accessServiceToken, (token) =>
      persistence.saveServiceToken(token),
    );
    accessServiceToken = rotated.resource;
    createdServiceTokenCredentials = rotated.credentials;
  } else {
    accessServiceToken = {
      id: state.accessServiceToken.id,
      name: state.accessServiceToken.name,
      clientId: state.accessServiceToken.clientId,
      created: false,
    };
  }

  const accessPolicies = {} as ApplySetupResult["resources"]["accessPolicies"];
  for (const surface of ["owner", "private"] as const) {
    const existing = state.accessPolicies[surface];
    const email =
      existing?.email === undefined
        ? await createPolicy(
            client,
            accountId,
            accessApplications[surface].id,
            CLOUDFLARE_SETUP_NAMES.accessPolicies.email,
            "allow",
            [{ email: { email: normalized.ownerEmail } }],
          )
        : { ...existing.email, created: false };
    const emailPolicyKey = resourceKey("access_email_policy", surface);
    if (email.created || interruptedResourceCreate(input, emailPolicyKey)) {
      await persistSetupState(() => persistence.saveResource(emailPolicyKey, email.id));
    }
    const serviceToken =
      existing?.serviceToken === undefined
        ? await createPolicy(
            client,
            accountId,
            accessApplications[surface].id,
            CLOUDFLARE_SETUP_NAMES.accessPolicies.serviceToken,
            "non_identity",
            [{ service_token: { token_id: accessServiceToken.id } }],
          )
        : { ...existing.serviceToken, created: false };
    const serviceTokenPolicyKey = resourceKey("access_service_token_policy", surface);
    if (serviceToken.created || interruptedResourceCreate(input, serviceTokenPolicyKey)) {
      await persistSetupState(() =>
        persistence.saveResource(serviceTokenPolicyKey, serviceToken.id),
      );
    }
    accessPolicies[surface] = { email, serviceToken };
  }

  return {
    mode: "apply",
    account: plan.account,
    zone: plan.zone,
    origins: plan.origins,
    resources: { d1, r2, accessApplications, accessPolicies, accessServiceToken },
    ...(createdServiceTokenCredentials === undefined ? {} : { createdServiceTokenCredentials }),
  };
}
