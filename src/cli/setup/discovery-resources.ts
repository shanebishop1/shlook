import { arrayResult, objectResult, pagedArray, type CloudflareApiClient } from "./api.ts";
import {
  CLOUDFLARE_SETUP_NAMES,
  CloudflareSetupError,
  MAX_PAGES,
  PAGE_SIZE,
  SERVICE_TOKEN_NEAR_EXPIRY_MS,
  type SetupOrigins,
  type SetupSurface,
} from "./model.ts";
import { exactOne, invalidResponse, isRecord, nonemptyString, resourceConflict } from "./shared.ts";

interface D1Record {
  uuid?: unknown;
  name?: unknown;
}

interface R2Record {
  name?: unknown;
}

interface R2ManagedDomainRecord {
  bucketId?: unknown;
  domain?: unknown;
  enabled?: unknown;
}

interface R2CustomDomainRecord {
  domain?: unknown;
  enabled?: unknown;
}

interface AccessApplicationRecord {
  id?: unknown;
  name?: unknown;
  domain?: unknown;
  type?: unknown;
}

interface ServiceTokenRecord {
  id?: unknown;
  name?: unknown;
  client_id?: unknown;
  enabled?: unknown;
  expires_at?: unknown;
}

interface AccessPolicyRecord {
  id?: unknown;
  name?: unknown;
  decision?: unknown;
  include?: unknown;
  exclude?: unknown;
  require?: unknown;
}

interface WorkersDomainRecord {
  id?: unknown;
  hostname?: unknown;
  zone_id?: unknown;
  service?: unknown;
}

interface WorkersServiceRecord {
  id?: unknown;
}

export async function inspectD1(client: CloudflareApiClient, accountId: string) {
  const items = await pagedArray(
    client,
    `/accounts/${accountId}/d1/database`,
    { name: CLOUDFLARE_SETUP_NAMES.d1 },
    (values) => values.some((value) => isRecord(value) && value.name === CLOUDFLARE_SETUP_NAMES.d1),
  );
  const exact = exactOne(
    items.filter(
      (value): value is D1Record =>
        isRecord(value) && value.name === CLOUDFLARE_SETUP_NAMES.d1 && nonemptyString(value.uuid),
    ),
  );
  return exact === undefined
    ? undefined
    : { id: exact.uuid as string, name: CLOUDFLARE_SETUP_NAMES.d1 };
}

export async function inspectR2(client: CloudflareApiClient, accountId: string) {
  let cursor: string | undefined;
  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
    const query = new URLSearchParams({
      name_contains: CLOUDFLARE_SETUP_NAMES.r2,
      per_page: String(PAGE_SIZE),
      ...(cursor === undefined ? {} : { cursor }),
    });
    const envelope = await client.request(`/accounts/${accountId}/r2/buckets?${query.toString()}`);
    const result = objectResult(envelope);
    if (!Array.isArray(result.buckets)) {
      throw new CloudflareSetupError(
        "cloudflare_response_invalid",
        "Cloudflare API returned an invalid response",
      );
    }
    const exact = exactOne(
      result.buckets.filter(
        (value): value is R2Record => isRecord(value) && value.name === CLOUDFLARE_SETUP_NAMES.r2,
      ),
    );
    if (exact !== undefined) {
      const bucketPath = `/accounts/${accountId}/r2/buckets/${encodeURIComponent(CLOUDFLARE_SETUP_NAMES.r2)}`;
      const [managedEnvelope, customEnvelope] = await Promise.all([
        client.request(`${bucketPath}/domains/managed`),
        client.request(`${bucketPath}/domains/custom`),
      ]);
      const managed = objectResult(managedEnvelope) as R2ManagedDomainRecord;
      if (
        !nonemptyString(managed.bucketId) ||
        !nonemptyString(managed.domain) ||
        typeof managed.enabled !== "boolean"
      ) {
        invalidResponse();
      }
      if (managed.enabled) resourceConflict();

      const customResult = objectResult(customEnvelope);
      if (!Array.isArray(customResult.domains)) invalidResponse();
      for (const value of customResult.domains) {
        if (
          !isRecord(value) ||
          !nonemptyString(value.domain) ||
          typeof value.enabled !== "boolean"
        ) {
          invalidResponse();
        }
        const custom = value as R2CustomDomainRecord;
        if (custom.enabled) resourceConflict();
      }
      return { name: CLOUDFLARE_SETUP_NAMES.r2 };
    }
    const next = envelope.result_info?.cursor;
    if (next === undefined || next === null || next === "") return undefined;
    if (!nonemptyString(next) || next === cursor) {
      throw new CloudflareSetupError(
        "cloudflare_pagination_invalid",
        "Cloudflare API returned invalid pagination data",
      );
    }
    cursor = next;
  }
  throw new CloudflareSetupError(
    "cloudflare_pagination_invalid",
    "Cloudflare API returned invalid pagination data",
  );
}

function selectApplication(
  items: unknown[],
  surface: SetupSurface,
  domain: string,
): { id: string; name: string; domain: string } | undefined {
  const name = CLOUDFLARE_SETUP_NAMES.accessApplications[surface];
  const candidates = items.filter(
    (value): value is AccessApplicationRecord =>
      isRecord(value) && (value.name === name || value.domain === domain),
  );
  const selected = exactOne(candidates);
  if (selected === undefined) return undefined;
  if (
    selected.name !== name ||
    selected.domain !== domain ||
    selected.type !== "self_hosted" ||
    !nonemptyString(selected.id)
  ) {
    resourceConflict();
  }
  return { id: selected.id, name, domain };
}

export async function inspectApplications(
  client: CloudflareApiClient,
  accountId: string,
  origins: SetupOrigins,
) {
  const items = await pagedArray(client, `/accounts/${accountId}/access/apps`, {});
  return {
    owner: selectApplication(items, "owner", new URL(origins.owner).hostname),
    private: selectApplication(items, "private", new URL(origins.private).hostname),
  };
}

export async function inspectServiceToken(client: CloudflareApiClient, accountId: string) {
  const items = await pagedArray(client, `/accounts/${accountId}/access/service_tokens`, {
    name: CLOUDFLARE_SETUP_NAMES.accessServiceToken,
  });
  const selected = exactOne(
    items.filter(
      (value): value is ServiceTokenRecord =>
        isRecord(value) && value.name === CLOUDFLARE_SETUP_NAMES.accessServiceToken,
    ),
  );
  if (selected === undefined) return undefined;
  if (
    !nonemptyString(selected.id) ||
    !nonemptyString(selected.client_id) ||
    selected.enabled === false ||
    !nonemptyString(selected.expires_at)
  ) {
    resourceConflict();
  }
  const expiresAt = Date.parse(selected.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) resourceConflict();
  return {
    id: selected.id,
    name: CLOUDFLARE_SETUP_NAMES.accessServiceToken,
    clientId: selected.client_id,
    enabled: true,
    expiresAt: selected.expires_at,
    nearExpiry: expiresAt <= Date.now() + SERVICE_TOKEN_NEAR_EXPIRY_MS,
  };
}

export async function inspectWorkerService(client: CloudflareApiClient, accountId: string) {
  const envelope = await client.requestOptional(`/accounts/${accountId}/workers/services/shlook`);
  if (envelope === undefined) return undefined;
  const selected = objectResult(envelope) as WorkersServiceRecord;
  if (selected.id !== "shlook") invalidResponse();
  return { id: "shlook", name: "shlook" };
}

export async function inspectWorkersDomains(
  client: CloudflareApiClient,
  accountId: string,
  zoneId: string,
  origins: SetupOrigins,
) {
  const records = await Promise.all(
    Object.values(origins).map(async (origin) => {
      const hostname = new URL(origin).hostname;
      const query = new URLSearchParams({ hostname, zone_id: zoneId });
      const values = arrayResult(
        await client.request(`/accounts/${accountId}/workers/domains?${query.toString()}`),
      );
      for (const value of values) {
        if (
          !isRecord(value) ||
          !nonemptyString(value.id) ||
          value.hostname !== hostname ||
          value.zone_id !== zoneId
        ) {
          invalidResponse();
        }
      }
      const selected = exactOne(values as WorkersDomainRecord[]);
      if (selected === undefined) return undefined;
      if (!nonemptyString(selected.service) || selected.service !== "shlook") resourceConflict();
      return {
        id: selected.id as string,
        hostname,
        service: selected.service,
      };
    }),
  );
  return records.filter((record): record is NonNullable<typeof record> => record !== undefined);
}

function emptyRules(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0);
}

function exactEmailPolicy(value: AccessPolicyRecord, email: string): boolean {
  return (
    value.decision === "allow" &&
    Array.isArray(value.include) &&
    value.include.length === 1 &&
    isRecord(value.include[0]) &&
    isRecord(value.include[0].email) &&
    value.include[0].email.email === email &&
    emptyRules(value.exclude) &&
    emptyRules(value.require)
  );
}

function exactTokenPolicy(value: AccessPolicyRecord, tokenId: string): boolean {
  return (
    value.decision === "non_identity" &&
    Array.isArray(value.include) &&
    value.include.length === 1 &&
    isRecord(value.include[0]) &&
    isRecord(value.include[0].service_token) &&
    value.include[0].service_token.token_id === tokenId &&
    emptyRules(value.exclude) &&
    emptyRules(value.require)
  );
}

function containsAnyValidServiceToken(value: AccessPolicyRecord): boolean {
  return [value.include, value.exclude, value.require].some(
    (rules) =>
      Array.isArray(rules) &&
      rules.some((rule) => isRecord(rule) && "any_valid_service_token" in rule),
  );
}

function validateMachineAuthorizationPolicies(
  items: unknown[],
  expectedName: string,
  tokenId?: string,
): void {
  for (const item of items) {
    if (!isRecord(item)) continue;
    const policy = item as AccessPolicyRecord;
    if (policy.decision === "bypass" || containsAnyValidServiceToken(policy)) resourceConflict();
    if (
      policy.decision === "non_identity" &&
      (tokenId === undefined ||
        policy.name !== expectedName ||
        !nonemptyString(policy.id) ||
        !exactTokenPolicy(policy, tokenId))
    ) {
      resourceConflict();
    }
  }
}

function selectPolicy(
  items: unknown[],
  name: string,
  exact: (policy: AccessPolicyRecord) => boolean,
): { id: string; name: string } | undefined {
  const candidates = items.filter(
    (value): value is AccessPolicyRecord =>
      isRecord(value) && (value.name === name || exact(value)),
  );
  const selected = exactOne(candidates);
  if (selected === undefined) return undefined;
  if (selected.name !== name || !nonemptyString(selected.id) || !exact(selected))
    resourceConflict();
  return { id: selected.id, name };
}

export async function inspectPolicies(
  client: CloudflareApiClient,
  accountId: string,
  appId: string,
  email: string,
  tokenId?: string,
) {
  const items = await pagedArray(
    client,
    `/accounts/${accountId}/access/apps/${encodeURIComponent(appId)}/policies`,
    {},
  );
  validateMachineAuthorizationPolicies(
    items,
    CLOUDFLARE_SETUP_NAMES.accessPolicies.serviceToken,
    tokenId,
  );
  const emailPolicy = selectPolicy(items, CLOUDFLARE_SETUP_NAMES.accessPolicies.email, (policy) =>
    exactEmailPolicy(policy, email),
  );
  const tokenPolicy = selectPolicy(
    items,
    CLOUDFLARE_SETUP_NAMES.accessPolicies.serviceToken,
    (policy) => tokenId !== undefined && exactTokenPolicy(policy, tokenId),
  );
  return { email: emailPolicy, serviceToken: tokenPolicy };
}
