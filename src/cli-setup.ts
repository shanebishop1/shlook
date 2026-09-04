const API_ORIGIN = "https://api.cloudflare.com";
const API_PREFIX = "/client/v4";
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_PAGES = 100;
const PAGE_SIZE = 100;

export const CLOUDFLARE_SETUP_NAMES = {
  d1: "shlook",
  r2: "shlook-assets",
  accessApplications: {
    owner: "shlook-owner",
    private: "shlook-private",
  },
  accessServiceToken: "shlook",
  accessPolicies: {
    email: "shlook-owner-email",
    serviceToken: "shlook-service-token",
  },
} as const;

export type SetupSurface = "owner" | "private";
export type CapabilityStatus = "available" | "missing_permission" | "rate_limited" | "unavailable";
export type SetupOperation = "create" | "reuse" | "controller" | "blocked";

export interface CloudflareSetupDependencies {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
}

export interface SetupInput {
  domain: string;
  ownerEmail: string;
  accountId?: string;
}

export interface ExistingServiceTokenCredentials {
  clientId: string;
  clientSecret: string;
}

export interface ApplySetupInput extends SetupInput {
  existingServiceToken?: ExistingServiceTokenCredentials;
}

export interface SetupCapability {
  status: CapabilityStatus;
  httpStatus?: number;
}

export interface SetupCapabilities {
  tokenVerification: SetupCapability;
  memberships: SetupCapability;
  zones: SetupCapability;
  d1: SetupCapability;
  r2: SetupCapability;
  accessApplications: SetupCapability;
  accessPolicies: SetupCapability;
  accessServiceTokens: SetupCapability;
  workersDomains: SetupCapability;
}

export interface SetupAccount {
  id: string;
  name: string;
}

export interface SetupZone {
  id: string;
  name: string;
}

export interface SetupOrigins {
  owner: string;
  private: string;
  public: string;
  share: string;
}

export interface SetupAction {
  resource:
    | "d1"
    | "r2"
    | "access_application"
    | "access_email_policy"
    | "access_service_token"
    | "access_service_token_policy"
    | "workers_domains";
  operation: SetupOperation;
  name: string;
  id?: string;
  surface?: SetupSurface;
  hostname?: string;
  hostnames?: string[];
  reason?: "capability_unavailable" | "controller_owned";
}

export interface SetupPlan {
  mode: "plan";
  ready: boolean;
  account: SetupAccount;
  zone: SetupZone;
  origins: SetupOrigins;
  capabilities: SetupCapabilities;
  actions: SetupAction[];
}

export interface AppliedResource {
  id: string;
  name: string;
  created: boolean;
}

export interface AppliedAccessApplication extends AppliedResource {
  domain: string;
}

export interface AppliedAccessPolicy {
  id: string;
  name: string;
  created: boolean;
}

export interface AppliedServiceToken {
  id: string;
  name: string;
  clientId: string;
  created: boolean;
}

export interface CreatedServiceTokenCredentials {
  clientId: string;
  clientSecret: string;
}

export interface ApplySetupResult {
  mode: "apply";
  account: SetupAccount;
  zone: SetupZone;
  origins: SetupOrigins;
  resources: {
    d1: AppliedResource;
    r2: AppliedResource;
    accessApplications: Record<SetupSurface, AppliedAccessApplication>;
    accessPolicies: Record<
      SetupSurface,
      { email: AppliedAccessPolicy; serviceToken: AppliedAccessPolicy }
    >;
    accessServiceToken: AppliedServiceToken;
  };
  createdServiceTokenCredentials?: CreatedServiceTokenCredentials;
}

export type CloudflareSetupErrorCode =
  | "bootstrap_token_required"
  | "bootstrap_token_conflict"
  | "invalid_domain"
  | "invalid_owner_email"
  | "invalid_account_id"
  | "invalid_service_token_credentials"
  | "cloudflare_request_failed"
  | "cloudflare_redirect_rejected"
  | "cloudflare_authentication_failed"
  | "cloudflare_api_error"
  | "cloudflare_response_invalid"
  | "cloudflare_response_too_large"
  | "cloudflare_pagination_invalid"
  | "cloudflare_permission_missing"
  | "account_not_found"
  | "account_ambiguous"
  | "zone_not_found"
  | "zone_ambiguous"
  | "setup_resource_conflict"
  | "setup_capabilities_unavailable"
  | "service_token_secret_unavailable"
  | "service_token_credentials_conflict";

export class CloudflareSetupError extends Error {
  readonly code: CloudflareSetupErrorCode;
  readonly status?: number;

  constructor(code: CloudflareSetupErrorCode, message: string, status?: number) {
    super(message);
    this.name = "CloudflareSetupError";
    this.code = code;
    this.status = status;
  }
}

interface NormalizedSetupInput {
  domain: string;
  ownerEmail: string;
  accountId?: string;
  origins: SetupOrigins;
}

interface ApiEnvelope {
  success: true;
  result: unknown;
  result_info?: Record<string, unknown>;
}

interface MembershipRecord {
  status?: unknown;
  account?: { id?: unknown; name?: unknown };
}

interface ZoneRecord {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  account?: { id?: unknown };
}

interface D1Record {
  uuid?: unknown;
  name?: unknown;
}

interface R2Record {
  name?: unknown;
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
  client_secret?: unknown;
  enabled?: unknown;
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
}

interface ExistingState {
  d1?: { id: string; name: string };
  r2?: { name: string };
  accessApplications: Partial<Record<SetupSurface, { id: string; name: string; domain: string }>>;
  accessPolicies: Partial<
    Record<
      SetupSurface,
      {
        email?: { id: string; name: string };
        serviceToken?: { id: string; name: string };
      }
    >
  >;
  accessServiceToken?: { id: string; name: string; clientId: string; enabled: boolean };
  workersDomains: Array<{ id: string; hostname: string }>;
}

interface Inspection {
  plan: SetupPlan;
  state: ExistingState;
  normalized: NormalizedSetupInput;
  client: CloudflareApiClient;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function invalidResponse(): never {
  throw new CloudflareSetupError(
    "cloudflare_response_invalid",
    "Cloudflare API returned an invalid response",
  );
}

function isIpv4Address(value: string): boolean {
  const labels = value.split(".");
  return (
    labels.length === 4 &&
    labels.every(
      (label) => /^(0|[1-9][0-9]{0,2})$/.test(label) && Number(label) >= 0 && Number(label) <= 255,
    )
  );
}

function resourceConflict(): never {
  throw new CloudflareSetupError(
    "setup_resource_conflict",
    "an existing Cloudflare resource conflicts with the required shlook setup",
  );
}

function normalizeInput(input: SetupInput): NormalizedSetupInput {
  const domain = input.domain;
  if (
    typeof domain !== "string" ||
    domain.length > 253 ||
    domain !== domain.toLowerCase() ||
    !domain.includes(".") ||
    !/^[a-z0-9.-]+$/.test(domain) ||
    isIpv4Address(domain) ||
    domain.startsWith(".") ||
    domain.endsWith(".") ||
    domain
      .split(".")
      .some(
        (label) =>
          label.length === 0 || label.length > 63 || label.startsWith("-") || label.endsWith("-"),
      )
  ) {
    throw new CloudflareSetupError(
      "invalid_domain",
      "domain must be a valid lowercase domain name",
    );
  }

  const ownerEmail = input.ownerEmail;
  const at = typeof ownerEmail === "string" ? ownerEmail.indexOf("@") : -1;
  const localPart = typeof ownerEmail === "string" && at > 0 ? ownerEmail.slice(0, at) : "";
  if (
    typeof ownerEmail !== "string" ||
    ownerEmail.length > 254 ||
    ownerEmail !== ownerEmail.toLowerCase() ||
    at <= 0 ||
    at !== ownerEmail.lastIndexOf("@") ||
    at > 64 ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(localPart) ||
    localPart.startsWith(".") ||
    localPart.endsWith(".") ||
    localPart.includes("..") ||
    /\s/.test(ownerEmail) ||
    hasControlCharacter(ownerEmail)
  ) {
    throw new CloudflareSetupError(
      "invalid_owner_email",
      "owner email must be a valid lowercase email address",
    );
  }
  const emailDomain = ownerEmail.slice(at + 1);
  if (
    emailDomain.length === 0 ||
    emailDomain.length > 253 ||
    !/^[a-z0-9.-]+$/.test(emailDomain) ||
    emailDomain
      .split(".")
      .some(
        (label) =>
          label.length === 0 || label.length > 63 || label.startsWith("-") || label.endsWith("-"),
      )
  ) {
    throw new CloudflareSetupError(
      "invalid_owner_email",
      "owner email must be a valid lowercase email address",
    );
  }

  const accountId = input.accountId;
  if (accountId !== undefined && !/^[0-9a-f]{32}$/.test(accountId)) {
    throw new CloudflareSetupError(
      "invalid_account_id",
      "account ID must be a 32-character lowercase hexadecimal identifier",
    );
  }

  return {
    domain,
    ownerEmail,
    accountId,
    origins: {
      owner: `https://shlook.${domain}`,
      private: `https://private.${domain}`,
      public: `https://public.${domain}`,
      share: `https://share.${domain}`,
    },
  };
}

function bootstrapToken(env: Record<string, string | undefined>): string {
  const standard = env.CLOUDFLARE_API_TOKEN;
  const alias = env.SHLOOK_CF_TOKEN;
  if (standard !== undefined && alias !== undefined && standard !== alias) {
    throw new CloudflareSetupError(
      "bootstrap_token_conflict",
      "conflicting Cloudflare bootstrap token environment variables",
    );
  }
  const value = standard ?? alias;
  if (
    value === undefined ||
    value.length === 0 ||
    value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    throw new CloudflareSetupError(
      "bootstrap_token_required",
      "a Cloudflare bootstrap API token is required",
    );
  }
  return value;
}

function validateExistingCredentials(
  credentials: ExistingServiceTokenCredentials | undefined,
): void {
  if (credentials === undefined) return;
  if (
    !nonemptyString(credentials.clientId) ||
    !nonemptyString(credentials.clientSecret) ||
    credentials.clientId.length > 4096 ||
    credentials.clientSecret.length > 4096 ||
    credentials.clientId.includes("\r") ||
    credentials.clientId.includes("\n") ||
    credentials.clientSecret.includes("\r") ||
    credentials.clientSecret.includes("\n")
  ) {
    throw new CloudflareSetupError(
      "invalid_service_token_credentials",
      "existing Access service token credentials are invalid",
    );
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null) {
    const length = Number(rawLength);
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new CloudflareSetupError(
        "cloudflare_response_too_large",
        "Cloudflare API response exceeded the allowed size",
      );
    }
  }
  if (response.body === null) {
    throw new CloudflareSetupError(
      "cloudflare_response_invalid",
      "Cloudflare API returned an invalid response",
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new CloudflareSetupError(
          "cloudflare_response_too_large",
          "Cloudflare API response exceeded the allowed size",
        );
      }
      chunks.push(value);
    }
  } catch (cause) {
    if (cause instanceof CloudflareSetupError) throw cause;
    throw new CloudflareSetupError(
      "cloudflare_response_invalid",
      "Cloudflare API returned an invalid response",
    );
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CloudflareSetupError(
      "cloudflare_response_invalid",
      "Cloudflare API returned an invalid response",
    );
  }
}

class CloudflareApiClient {
  readonly #fetch: typeof fetch;
  readonly #token: string;

  constructor(dependencies: CloudflareSetupDependencies) {
    this.#fetch = dependencies.fetch;
    this.#token = bootstrapToken(dependencies.env);
  }

  async request(path: string, method = "GET", body?: unknown): Promise<ApiEnvelope> {
    let response: Response;
    try {
      response = await this.#fetch(`${API_ORIGIN}${API_PREFIX}${path}`, {
        method,
        redirect: "manual",
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new CloudflareSetupError("cloudflare_request_failed", "Cloudflare API request failed");
    }

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new CloudflareSetupError(
        "cloudflare_redirect_rejected",
        "Cloudflare API redirects are not allowed",
        response.status,
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new CloudflareSetupError(
        "cloudflare_api_error",
        "Cloudflare API request failed",
        response.status,
      );
    }

    const decoded = await readBoundedJson(response);
    if (!isRecord(decoded) || decoded.success !== true || !("result" in decoded)) {
      throw new CloudflareSetupError(
        "cloudflare_response_invalid",
        "Cloudflare API returned an invalid response",
      );
    }
    if (decoded.result_info !== undefined && !isRecord(decoded.result_info)) {
      throw new CloudflareSetupError(
        "cloudflare_response_invalid",
        "Cloudflare API returned an invalid response",
      );
    }
    return decoded as unknown as ApiEnvelope;
  }
}

function arrayResult(envelope: ApiEnvelope): unknown[] {
  if (!Array.isArray(envelope.result)) {
    throw new CloudflareSetupError(
      "cloudflare_response_invalid",
      "Cloudflare API returned an invalid response",
    );
  }
  return envelope.result;
}

function objectResult(envelope: ApiEnvelope): Record<string, unknown> {
  if (!isRecord(envelope.result)) {
    throw new CloudflareSetupError(
      "cloudflare_response_invalid",
      "Cloudflare API returned an invalid response",
    );
  }
  return envelope.result;
}

function totalPages(envelope: ApiEnvelope, currentPage: number): number {
  const raw = envelope.result_info?.total_pages;
  if (raw === undefined) return currentPage;
  if (!Number.isSafeInteger(raw) || (raw as number) < currentPage || (raw as number) > MAX_PAGES) {
    throw new CloudflareSetupError(
      "cloudflare_pagination_invalid",
      "Cloudflare API returned invalid pagination data",
    );
  }
  return raw as number;
}

async function pagedArray(
  client: CloudflareApiClient,
  path: string,
  parameters: Record<string, string>,
  stop?: (items: unknown[]) => boolean,
): Promise<unknown[]> {
  const items: unknown[] = [];
  for (let currentPage = 1; currentPage <= MAX_PAGES; currentPage += 1) {
    const query = new URLSearchParams({
      ...parameters,
      page: String(currentPage),
      per_page: String(PAGE_SIZE),
    });
    const envelope = await client.request(`${path}?${query.toString()}`);
    items.push(...arrayResult(envelope));
    if (stop?.(items)) return items;
    if (currentPage >= totalPages(envelope, currentPage)) return items;
  }
  throw new CloudflareSetupError(
    "cloudflare_pagination_invalid",
    "Cloudflare API returned invalid pagination data",
  );
}

async function verifyToken(client: CloudflareApiClient): Promise<void> {
  let envelope: ApiEnvelope;
  try {
    envelope = await client.request("/user/tokens/verify");
  } catch (cause) {
    if (
      cause instanceof CloudflareSetupError &&
      cause.code === "cloudflare_api_error" &&
      (cause.status === 401 || cause.status === 403)
    ) {
      throw new CloudflareSetupError(
        "cloudflare_authentication_failed",
        "Cloudflare bootstrap token verification failed",
        cause.status,
      );
    }
    throw cause;
  }
  const result = objectResult(envelope);
  if (result.status !== "active") {
    throw new CloudflareSetupError(
      "cloudflare_authentication_failed",
      "Cloudflare bootstrap token verification failed",
    );
  }
}

async function resolveAccount(
  client: CloudflareApiClient,
  requestedAccountId?: string,
): Promise<SetupAccount> {
  let memberships: unknown[];
  try {
    memberships = await pagedArray(
      client,
      "/memberships",
      { status: "accepted" },
      requestedAccountId === undefined
        ? undefined
        : (items) =>
            items.some(
              (item) =>
                isRecord(item) &&
                item.status === "accepted" &&
                isRecord(item.account) &&
                item.account.id === requestedAccountId,
            ),
    );
  } catch (cause) {
    throwPermissionError(cause);
  }
  const accepted = memberships.filter((value): value is MembershipRecord => {
    if (
      !isRecord(value) ||
      !["accepted", "pending", "rejected"].includes(String(value.status)) ||
      !isRecord(value.account) ||
      typeof value.account.id !== "string" ||
      !/^[0-9a-f]{32}$/.test(value.account.id) ||
      !nonemptyString(value.account.name)
    ) {
      invalidResponse();
    }
    return value.status === "accepted";
  });
  const selected =
    requestedAccountId === undefined
      ? accepted
      : accepted.filter((membership) => membership.account?.id === requestedAccountId);
  if (selected.length === 0) {
    throw new CloudflareSetupError(
      "account_not_found",
      "no accepted Cloudflare account membership matched setup",
    );
  }
  if (selected.length !== 1) {
    throw new CloudflareSetupError(
      "account_ambiguous",
      "Cloudflare account selection is ambiguous",
    );
  }
  return {
    id: selected[0].account!.id as string,
    name: selected[0].account!.name as string,
  };
}

async function resolveZone(
  client: CloudflareApiClient,
  accountId: string,
  domain: string,
): Promise<SetupZone> {
  let zones: unknown[];
  try {
    zones = await pagedArray(client, "/zones", {
      name: domain,
      "account.id": accountId,
      status: "active",
    });
  } catch (cause) {
    throwPermissionError(cause);
  }
  for (const value of zones) {
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      !/^[0-9a-f]{32}$/.test(value.id) ||
      !nonemptyString(value.name) ||
      !nonemptyString(value.status) ||
      !isRecord(value.account) ||
      typeof value.account.id !== "string" ||
      !/^[0-9a-f]{32}$/.test(value.account.id)
    ) {
      invalidResponse();
    }
  }
  const exact = zones.filter(
    (value): value is ZoneRecord =>
      isRecord(value) &&
      value.name === domain &&
      value.status === "active" &&
      isRecord(value.account) &&
      value.account.id === accountId &&
      nonemptyString(value.id),
  );
  if (exact.length === 0) {
    throw new CloudflareSetupError(
      "zone_not_found",
      "no exact active Cloudflare zone matched the domain",
    );
  }
  if (exact.length !== 1) {
    throw new CloudflareSetupError("zone_ambiguous", "Cloudflare zone selection is ambiguous");
  }
  return { id: exact[0].id as string, name: domain };
}

function throwPermissionError(cause: unknown): never {
  if (
    cause instanceof CloudflareSetupError &&
    cause.code === "cloudflare_api_error" &&
    (cause.status === 401 || cause.status === 403)
  ) {
    throw new CloudflareSetupError(
      "cloudflare_permission_missing",
      "Cloudflare token lacks a required read permission",
      cause.status,
    );
  }
  throw cause;
}

function capabilityFromError(cause: unknown): SetupCapability | undefined {
  if (!(cause instanceof CloudflareSetupError) || cause.code !== "cloudflare_api_error") {
    return undefined;
  }
  if (cause.status === 401 || cause.status === 403) {
    return { status: "missing_permission", httpStatus: cause.status };
  }
  if (cause.status === 429) return { status: "rate_limited", httpStatus: 429 };
  return {
    status: "unavailable",
    ...(cause.status === undefined ? {} : { httpStatus: cause.status }),
  };
}

async function probe<T>(
  operation: () => Promise<T>,
): Promise<{ capability: SetupCapability; value?: T }> {
  try {
    return { capability: { status: "available" }, value: await operation() };
  } catch (cause) {
    const capability = capabilityFromError(cause);
    if (capability !== undefined) return { capability };
    throw cause;
  }
}

function exactOne<T>(items: T[]): T | undefined {
  if (items.length > 1) resourceConflict();
  return items[0];
}

async function inspectD1(client: CloudflareApiClient, accountId: string) {
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

async function inspectR2(client: CloudflareApiClient, accountId: string) {
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
    if (exact !== undefined) return { name: CLOUDFLARE_SETUP_NAMES.r2 };
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

async function inspectApplications(
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

async function inspectServiceToken(client: CloudflareApiClient, accountId: string) {
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
    selected.enabled === false
  ) {
    resourceConflict();
  }
  return {
    id: selected.id,
    name: CLOUDFLARE_SETUP_NAMES.accessServiceToken,
    clientId: selected.client_id,
    enabled: true,
  };
}

async function inspectWorkersDomains(
  client: CloudflareApiClient,
  accountId: string,
  zoneId: string,
  origins: SetupOrigins,
) {
  const query = new URLSearchParams({ zone_id: zoneId });
  const records = arrayResult(
    await client.request(`/accounts/${accountId}/workers/domains?${query.toString()}`),
  );
  const expected = new Set(Object.values(origins).map((origin) => new URL(origin).hostname));
  return records
    .filter(
      (value): value is WorkersDomainRecord =>
        isRecord(value) &&
        value.zone_id === zoneId &&
        nonemptyString(value.id) &&
        nonemptyString(value.hostname) &&
        expected.has(value.hostname),
    )
    .map((value) => ({ id: value.id as string, hostname: value.hostname as string }));
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

async function inspectPolicies(
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

function blockedOperation(capability: SetupCapability): "blocked" | "create" {
  return capability.status === "available" ? "create" : "blocked";
}

function resourceAction(
  resource: "d1" | "r2" | "access_service_token",
  name: string,
  capability: SetupCapability,
  existing?: { id?: string; name?: string },
): SetupAction {
  if (existing !== undefined) return { resource, operation: "reuse", name, id: existing.id };
  const operation = blockedOperation(capability);
  return {
    resource,
    operation,
    name,
    ...(operation === "blocked" ? { reason: "capability_unavailable" as const } : {}),
  };
}

async function inspectSetup(
  input: SetupInput,
  dependencies: CloudflareSetupDependencies,
): Promise<Inspection> {
  const normalized = normalizeInput(input);
  const client = new CloudflareApiClient(dependencies);
  await verifyToken(client);
  const account = await resolveAccount(client, normalized.accountId);
  const zone = await resolveZone(client, account.id, normalized.domain);

  const [d1Probe, r2Probe, appsProbe, serviceTokenProbe, workersDomainsProbe] = await Promise.all([
    probe(() => inspectD1(client, account.id)),
    probe(() => inspectR2(client, account.id)),
    probe(() => inspectApplications(client, account.id, normalized.origins)),
    probe(() => inspectServiceToken(client, account.id)),
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
    workersDomains: workersDomainsProbe.capability,
  };
  const state: ExistingState = {
    d1: d1Probe.value,
    r2: r2Probe.value,
    accessApplications,
    accessPolicies,
    accessServiceToken,
    workersDomains: workersDomainsProbe.value ?? [],
  };

  const actions: SetupAction[] = [
    resourceAction("d1", CLOUDFLARE_SETUP_NAMES.d1, capabilities.d1, state.d1),
    resourceAction("r2", CLOUDFLARE_SETUP_NAMES.r2, capabilities.r2, state.r2),
  ];
  for (const surface of ["owner", "private"] as const) {
    const app = state.accessApplications[surface];
    const hostname = new URL(normalized.origins[surface]).hostname;
    const appOperation =
      app === undefined ? blockedOperation(capabilities.accessApplications) : "reuse";
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
    resourceAction(
      "access_service_token",
      CLOUDFLARE_SETUP_NAMES.accessServiceToken,
      capabilities.accessServiceTokens,
      state.accessServiceToken,
    ),
  );
  for (const surface of ["owner", "private"] as const) {
    const policies = state.accessPolicies[surface];
    for (const kind of ["email", "serviceToken"] as const) {
      const existing = policies?.[kind];
      const operation =
        existing === undefined ? blockedOperation(capabilities.accessPolicies) : "reuse";
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
    resource: "workers_domains",
    operation: "controller",
    name: "shlook custom domains",
    hostnames: Object.values(normalized.origins).map((origin) => new URL(origin).hostname),
    reason: "controller_owned",
  });

  return {
    client,
    normalized,
    state,
    plan: {
      mode: "plan",
      ready: Object.values(capabilities).every((capability) => capability.status === "available"),
      account,
      zone,
      origins: normalized.origins,
      capabilities,
      actions,
    },
  };
}

export async function planSetup(
  input: SetupInput,
  dependencies: CloudflareSetupDependencies,
): Promise<SetupPlan> {
  return (await inspectSetup(input, dependencies)).plan;
}

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

async function createD1(client: CloudflareApiClient, accountId: string): Promise<AppliedResource> {
  const created = requireObjectIdentity(
    await client.request(`/accounts/${accountId}/d1/database`, "POST", {
      name: CLOUDFLARE_SETUP_NAMES.d1,
    }),
    CLOUDFLARE_SETUP_NAMES.d1,
    "uuid",
  );
  return { ...created, created: true };
}

async function createR2(client: CloudflareApiClient, accountId: string): Promise<AppliedResource> {
  const created = requireObjectIdentity(
    await client.request(`/accounts/${accountId}/r2/buckets`, "POST", {
      name: CLOUDFLARE_SETUP_NAMES.r2,
    }),
    CLOUDFLARE_SETUP_NAMES.r2,
    "name",
  );
  return { id: created.name, name: created.name, created: true };
}

async function createApplication(
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

async function createServiceToken(
  client: CloudflareApiClient,
  accountId: string,
): Promise<{ resource: AppliedServiceToken; credentials: CreatedServiceTokenCredentials }> {
  const result = objectResult(
    await client.request(`/accounts/${accountId}/access/service_tokens`, "POST", {
      name: CLOUDFLARE_SETUP_NAMES.accessServiceToken,
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
  return {
    resource: {
      id: result.id,
      name: CLOUDFLARE_SETUP_NAMES.accessServiceToken,
      clientId: result.client_id,
      created: true,
    },
    credentials: { clientId: result.client_id, clientSecret: result.client_secret },
  };
}

async function createPolicy(
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

  if (state.accessServiceToken !== undefined) {
    if (input.existingServiceToken === undefined) {
      throw new CloudflareSetupError(
        "service_token_secret_unavailable",
        "the existing shlook Access service token secret cannot be recovered",
      );
    }
    if (input.existingServiceToken.clientId !== state.accessServiceToken.clientId) {
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

  const accountId = plan.account.id;
  const d1: AppliedResource =
    state.d1 === undefined ? await createD1(client, accountId) : { ...state.d1, created: false };
  const r2: AppliedResource =
    state.r2 === undefined
      ? await createR2(client, accountId)
      : { id: state.r2.name, name: state.r2.name, created: false };

  const accessApplications = {} as Record<SetupSurface, AppliedAccessApplication>;
  for (const surface of ["owner", "private"] as const) {
    const existing = state.accessApplications[surface];
    accessApplications[surface] =
      existing === undefined
        ? await createApplication(client, accountId, surface, normalized.origins[surface])
        : { ...existing, created: false };
  }

  let accessServiceToken: AppliedServiceToken;
  let createdServiceTokenCredentials: CreatedServiceTokenCredentials | undefined;
  if (state.accessServiceToken === undefined) {
    const created = await createServiceToken(client, accountId);
    accessServiceToken = created.resource;
    createdServiceTokenCredentials = created.credentials;
  } else {
    accessServiceToken = { ...state.accessServiceToken, created: false };
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
