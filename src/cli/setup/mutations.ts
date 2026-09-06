import { objectResult, type ApiEnvelope, type CloudflareApiClient } from "./api.ts";
import {
  CLOUDFLARE_SETUP_NAMES,
  CloudflareSetupError,
  SERVICE_TOKEN_DURATION,
  type AppliedAccessApplication,
  type AppliedAccessPolicy,
  type AppliedResource,
  type AppliedServiceToken,
  type CreatedServiceTokenCredentials,
  type ExistingState,
  type PendingServiceToken,
  type SetupSurface,
} from "./model.ts";
import { invalidResponse, nonemptyString } from "./shared.ts";

function requireObjectIdentity(
  envelope: ApiEnvelope,
  expectedName: string,
  idField: string,
): { id: string; name: string } {
  const result = objectResult(envelope);
  if (result.name !== expectedName || !nonemptyString(result[idField])) {
    throw new CloudflareSetupError(
      "cloudflare_response_invalid",
      "Cloudflare API returned an invalid response",
    );
  }
  return { id: result[idField], name: expectedName };
}

export async function createD1(
  client: CloudflareApiClient,
  accountId: string,
): Promise<AppliedResource> {
  const created = requireObjectIdentity(
    await client.request(`/accounts/${accountId}/d1/database`, "POST", {
      name: CLOUDFLARE_SETUP_NAMES.d1,
    }),
    CLOUDFLARE_SETUP_NAMES.d1,
    "uuid",
  );
  return { ...created, created: true };
}

export async function createR2(
  client: CloudflareApiClient,
  accountId: string,
): Promise<AppliedResource> {
  const created = requireObjectIdentity(
    await client.request(`/accounts/${accountId}/r2/buckets`, "POST", {
      name: CLOUDFLARE_SETUP_NAMES.r2,
    }),
    CLOUDFLARE_SETUP_NAMES.r2,
    "name",
  );
  return { id: created.name, name: created.name, created: true };
}

export async function createApplication(
  client: CloudflareApiClient,
  accountId: string,
  surface: SetupSurface,
  origin: string,
): Promise<AppliedAccessApplication> {
  const name = CLOUDFLARE_SETUP_NAMES.accessApplications[surface];
  const domain = new URL(origin).hostname;
  const result = objectResult(
    await client.request(`/accounts/${accountId}/access/apps`, "POST", {
      name,
      domain,
      type: "self_hosted",
      session_duration: "24h",
    }),
  );
  if (
    !nonemptyString(result.id) ||
    result.name !== name ||
    result.domain !== domain ||
    result.type !== "self_hosted"
  ) {
    throw new CloudflareSetupError(
      "cloudflare_response_invalid",
      "Cloudflare API returned an invalid response",
    );
  }
  return { id: result.id, name, domain, created: true };
}

export async function createServiceToken(
  client: CloudflareApiClient,
  accountId: string,
  saveServiceToken: (token: PendingServiceToken) => Promise<void>,
): Promise<{ resource: AppliedServiceToken; credentials: CreatedServiceTokenCredentials }> {
  const result = objectResult(
    await client.request(`/accounts/${accountId}/access/service_tokens`, "POST", {
      name: CLOUDFLARE_SETUP_NAMES.accessServiceToken,
      duration: SERVICE_TOKEN_DURATION,
    }),
  );
  if (
    !nonemptyString(result.id) ||
    result.name !== CLOUDFLARE_SETUP_NAMES.accessServiceToken ||
    !nonemptyString(result.client_id) ||
    !nonemptyString(result.client_secret)
  ) {
    throw new CloudflareSetupError(
      "cloudflare_response_invalid",
      "Cloudflare API returned an invalid response",
    );
  }
  const pending = {
    resourceId: result.id,
    clientId: result.client_id,
    clientSecret: result.client_secret,
  };
  await persistServiceTokenCredentials(() => saveServiceToken(pending));
  return {
    resource: {
      id: pending.resourceId,
      name: CLOUDFLARE_SETUP_NAMES.accessServiceToken,
      clientId: pending.clientId,
      created: true,
    },
    credentials: { clientId: pending.clientId, clientSecret: pending.clientSecret },
  };
}

export async function updateServiceTokenDuration(
  client: CloudflareApiClient,
  accountId: string,
  token: NonNullable<ExistingState["accessServiceToken"]>,
): Promise<void> {
  const result = objectResult(
    await client.request(
      `/accounts/${accountId}/access/service_tokens/${encodeURIComponent(token.id)}`,
      "PUT",
      { name: CLOUDFLARE_SETUP_NAMES.accessServiceToken, duration: SERVICE_TOKEN_DURATION },
    ),
  );
  if (
    result.id !== token.id ||
    result.name !== CLOUDFLARE_SETUP_NAMES.accessServiceToken ||
    result.client_id !== token.clientId ||
    result.duration !== SERVICE_TOKEN_DURATION ||
    !nonemptyString(result.expires_at)
  ) {
    invalidResponse();
  }
}

export async function rotateServiceToken(
  client: CloudflareApiClient,
  accountId: string,
  token: NonNullable<ExistingState["accessServiceToken"]>,
  saveServiceToken: (token: PendingServiceToken) => Promise<void>,
): Promise<{ resource: AppliedServiceToken; credentials: CreatedServiceTokenCredentials }> {
  const result = objectResult(
    await client.request(
      `/accounts/${accountId}/access/service_tokens/${encodeURIComponent(token.id)}/rotate`,
      "POST",
    ),
  );
  if (
    result.id !== token.id ||
    result.name !== CLOUDFLARE_SETUP_NAMES.accessServiceToken ||
    result.client_id !== token.clientId ||
    !nonemptyString(result.client_secret)
  ) {
    invalidResponse();
  }
  const pending = {
    resourceId: token.id,
    clientId: token.clientId,
    clientSecret: result.client_secret,
  };
  await persistServiceTokenCredentials(() => saveServiceToken(pending));
  return {
    resource: {
      id: token.id,
      name: token.name,
      clientId: token.clientId,
      created: false,
    },
    credentials: { clientId: pending.clientId, clientSecret: pending.clientSecret },
  };
}

export async function createPolicy(
  client: CloudflareApiClient,
  accountId: string,
  appId: string,
  name: string,
  decision: "allow" | "non_identity",
  include: Array<Record<string, unknown>>,
): Promise<AppliedAccessPolicy> {
  const result = objectResult(
    await client.request(
      `/accounts/${accountId}/access/apps/${encodeURIComponent(appId)}/policies`,
      "POST",
      {
        name,
        decision,
        include,
      },
    ),
  );
  if (!nonemptyString(result.id)) {
    throw new CloudflareSetupError(
      "cloudflare_response_invalid",
      "Cloudflare API returned an invalid response",
    );
  }
  return { id: result.id, name, created: true };
}

export async function persistSetupState(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch {
    throw new CloudflareSetupError(
      "setup_state_persistence_failed",
      "unable to persist transactional shlook setup state",
    );
  }
}

async function persistServiceTokenCredentials(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch {
    throw new CloudflareSetupError(
      "service_token_recovery_required",
      "Access service token credentials changed but could not be saved; rerun setup apply to recover",
    );
  }
}
