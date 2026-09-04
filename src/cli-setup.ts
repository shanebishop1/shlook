const API_ORIGIN = "https://api.cloudflare.com";
const API_PREFIX = "/client/v4";
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_PAGES = 100;
const PAGE_SIZE = 100;
// Service tokens are deliberately short-lived: 2160 hours is 90 days.
const SERVICE_TOKEN_DURATION = "2160h";
// Block automatic reuse during the final week so rotation can be handled explicitly.
const SERVICE_TOKEN_NEAR_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

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
export type SetupOperation = "create" | "adopt" | "reuse" | "renew" | "controller" | "blocked";
export type SetupIntentAction = "create" | "adopt";
export type SetupResourceKey =
  | "d1"
  | "r2"
  | "access_application_owner"
  | "access_application_private"
  | "access_service_token"
  | "access_email_policy_owner"
  | "access_email_policy_private"
  | "access_service_token_policy_owner"
  | "access_service_token_policy_private"
  | "worker_service"
  | "workers_domain_owner"
  | "workers_domain_private"
  | "workers_domain_public"
  | "workers_domain_share";

export interface SetupResourceIntent {
  action: SetupIntentAction;
  name: string;
  id?: string;
}

export interface SetupDeploymentManifest {
  version: 1;
  domain: string;
  ownerEmail: string;
  accountId: string;
  zoneId: string;
  resources: Record<SetupResourceKey, SetupResourceIntent>;
}

export interface PendingServiceToken {
  resourceId: string;
  clientId: string;
  clientSecret: string;
}

export interface SetupPersistence {
  saveIntent(manifest: SetupDeploymentManifest): Promise<void>;
  saveResource(resource: SetupResourceKey, id: string): Promise<void>;
  beginServiceTokenRotation(resourceId: string, clientId: string): Promise<void>;
  saveServiceToken(token: PendingServiceToken): Promise<void>;
}

export interface CloudflareSetupDependencies {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
}

export interface SetupInput {
  domain: string;
  ownerEmail: string;
  accountId?: string;
  /** Explicitly permits taking ownership of fixed-name resources. This is dangerous. */
  adoptExisting?: boolean;
  deploymentManifest?: SetupDeploymentManifest;
}

export interface ExistingServiceTokenCredentials {
  clientId: string;
  clientSecret: string;
}

export interface ApplySetupInput extends SetupInput {
  existingServiceToken?: ExistingServiceTokenCredentials;
  /** Runtime-only journal signal used to resume an interrupted secret rotation. */
  serviceTokenRotationPending?: boolean;
  /** Runtime-only signal that a journaled rotation already persisted its new secret. */
  serviceTokenRotationCompleted?: boolean;
  persistence?: SetupPersistence;
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
  workersServices: SetupCapability;
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
    | "worker_service"
    | "workers_domains";
  operation: SetupOperation;
  name: string;
  id?: string;
  surface?: SetupSurface;
  hostname?: string;
  hostnames?: string[];
  reason?: "capability_unavailable" | "controller_owned" | "service_token_expiring";
}

export interface SetupPlan {
  mode: "plan";
  ready: boolean;
  account: SetupAccount;
  zone: SetupZone;
  origins: SetupOrigins;
  capabilities: SetupCapabilities;
  actions: SetupAction[];
  deploymentManifest: SetupDeploymentManifest;
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
  | "setup_resource_collision"
  | "setup_manifest_mismatch"
  | "setup_state_persistence_required"
  | "setup_state_persistence_failed"
  | "setup_capabilities_unavailable"
  | "service_token_recovery_required"
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
  accessServiceToken?: {
    id: string;
    name: string;
    clientId: string;
    enabled: boolean;
    expiresAt: string;
    nearExpiry: boolean;
  };
  workerService?: { id: string; name: string };
  workersDomains: Array<{ id: string; hostname: string; service: string }>;
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

function resourceCollision(): never {
  throw new CloudflareSetupError(
    "setup_resource_collision",
    "an existing fixed-name Cloudflare resource is not owned by this shlook deployment; rerun with --adopt-existing only if intentional",
  );
}

function manifestMismatch(): never {
  throw new CloudflareSetupError(
    "setup_manifest_mismatch",
    "the persisted shlook deployment manifest does not match Cloudflare or the requested target",
  );
}

function resourceKey(
  kind:
    | "access_application"
    | "access_email_policy"
    | "access_service_token_policy"
    | "workers_domain",
  surface: "owner" | "private" | "public" | "share",
): SetupResourceKey {
  return `${kind}_${surface}` as SetupResourceKey;
}

function expectedResource(
  input: SetupInput,
  key: SetupResourceKey,
  name: string,
  existing: { id: string } | undefined,
  discoverCreatedWorkersResources = false,
): void {
  const expected = input.deploymentManifest?.resources[key];
  if (input.deploymentManifest === undefined) {
    if (existing !== undefined && input.adoptExisting !== true) resourceCollision();
    return;
  }
  if (expected === undefined) manifestMismatch();
  if (expected.name !== name) manifestMismatch();
  if (existing === undefined) {
    if (
      expected.action !== "create" ||
      (expected.id !== undefined &&
        !(
          (key === "worker_service" && expected.id === "shlook") ||
          (key === "r2" && expected.id === CLOUDFLARE_SETUP_NAMES.r2)
        ))
    )
      manifestMismatch();
    return;
  }
  if (expected.id === undefined) {
    if (
      key === "access_service_token" &&
      expected.action === "create" &&
      Object.keys(expected).length === 2
    ) {
      return;
    }
    if (
      [
        "d1",
        "r2",
        "access_application_owner",
        "access_application_private",
        "access_email_policy_owner",
        "access_email_policy_private",
        "access_service_token_policy_owner",
        "access_service_token_policy_private",
      ].includes(key) &&
      expected.action === "create" &&
      Object.keys(expected).length === 2
    ) {
      return;
    }
    if (
      !discoverCreatedWorkersResources ||
      expected.action !== "create" ||
      !key.startsWith("workers_domain_")
    )
      manifestMismatch();
    return;
  }
  if (expected.id !== existing.id) manifestMismatch();
}

function interruptedResourceCreate(input: SetupInput, key: SetupResourceKey): boolean {
  const expected = input.deploymentManifest?.resources[key];
  return (
    expected !== undefined &&
    expected.action === "create" &&
    expected.id === undefined &&
    Object.keys(expected).length === 2
  );
}

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

  async requestOptional(path: string): Promise<ApiEnvelope | undefined> {
    try {
      return await this.request(path);
    } catch (cause) {
      if (
        cause instanceof CloudflareSetupError &&
        cause.code === "cloudflare_api_error" &&
        cause.status === 404
      ) {
        return undefined;
      }
      throw cause;
    }
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

function invalidPagination(): never {
  throw new CloudflareSetupError(
    "cloudflare_pagination_invalid",
    "Cloudflare API returned invalid pagination data",
  );
}

function optionalPageNumber(
  resultInfo: Record<string, unknown>,
  field: string,
  minimum: number,
): number | undefined {
  const value = resultInfo[field];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalidPagination();
  return value as number;
}

function hasNextPage(
  envelope: ApiEnvelope,
  currentPage: number,
  pageItemCount: number,
  accumulatedItemCount: number,
): boolean {
  const resultInfo = envelope.result_info;
  if (resultInfo === undefined) return pageItemCount === PAGE_SIZE;

  const reportedPage = optionalPageNumber(resultInfo, "page", 1);
  const perPage = optionalPageNumber(resultInfo, "per_page", 1);
  const count = optionalPageNumber(resultInfo, "count", 0);
  const totalCount = optionalPageNumber(resultInfo, "total_count", 0);
  const totalPages = optionalPageNumber(resultInfo, "total_pages", 0);
  if (reportedPage !== undefined && reportedPage !== currentPage) invalidPagination();
  if (count !== undefined && count !== pageItemCount) invalidPagination();

  if (totalPages !== undefined) {
    if (
      totalPages > MAX_PAGES ||
      (totalPages === 0 ? currentPage !== 1 || pageItemCount !== 0 : totalPages < currentPage)
    ) {
      invalidPagination();
    }
    return currentPage < totalPages;
  }

  if (totalCount !== undefined) {
    if (accumulatedItemCount > totalCount) invalidPagination();
    if (accumulatedItemCount >= totalCount) return false;
  }

  const effectivePerPage = perPage ?? PAGE_SIZE;
  return pageItemCount >= effectivePerPage;
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
    const pageItems = arrayResult(envelope);
    items.push(...pageItems);
    const morePages = hasNextPage(envelope, currentPage, pageItems.length, items.length);
    if (stop?.(items)) return items;
    if (!morePages) return items;
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

async function inspectWorkerService(client: CloudflareApiClient, accountId: string) {
  const envelope = await client.requestOptional(`/accounts/${accountId}/workers/services/shlook`);
  if (envelope === undefined) return undefined;
  const selected = objectResult(envelope) as WorkersServiceRecord;
  if (selected.id !== "shlook") invalidResponse();
  return { id: "shlook", name: "shlook" };
}

async function inspectWorkersDomains(
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

function buildDeploymentManifest(
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

function validateDeploymentOwnership(
  input: SetupInput,
  normalized: NormalizedSetupInput,
  account: SetupAccount,
  zone: SetupZone,
  state: ExistingState,
  discoverCreatedWorkersResources = false,
): void {
  const manifest = input.deploymentManifest;
  if (
    manifest !== undefined &&
    (manifest.version !== 1 ||
      manifest.domain !== normalized.domain ||
      manifest.ownerEmail !== normalized.ownerEmail ||
      manifest.accountId !== account.id ||
      manifest.zoneId !== zone.id)
  ) {
    manifestMismatch();
  }

  expectedResource(input, "d1", CLOUDFLARE_SETUP_NAMES.d1, state.d1);
  expectedResource(
    input,
    "r2",
    CLOUDFLARE_SETUP_NAMES.r2,
    state.r2 === undefined ? undefined : { id: state.r2.name },
  );
  for (const surface of ["owner", "private"] as const) {
    expectedResource(
      input,
      resourceKey("access_application", surface),
      CLOUDFLARE_SETUP_NAMES.accessApplications[surface],
      state.accessApplications[surface],
    );
    expectedResource(
      input,
      resourceKey("access_email_policy", surface),
      CLOUDFLARE_SETUP_NAMES.accessPolicies.email,
      state.accessPolicies[surface]?.email,
    );
    expectedResource(
      input,
      resourceKey("access_service_token_policy", surface),
      CLOUDFLARE_SETUP_NAMES.accessPolicies.serviceToken,
      state.accessPolicies[surface]?.serviceToken,
    );
  }
  expectedResource(
    input,
    "access_service_token",
    CLOUDFLARE_SETUP_NAMES.accessServiceToken,
    state.accessServiceToken,
  );
  expectedResource(input, "worker_service", "shlook", state.workerService);
  for (const surface of ["owner", "private", "public", "share"] as const) {
    const hostname = new URL(normalized.origins[surface]).hostname;
    const matches = state.workersDomains.filter((record) => record.hostname === hostname);
    expectedResource(
      input,
      resourceKey("workers_domain", surface),
      hostname,
      exactOne(matches),
      discoverCreatedWorkersResources,
    );
  }
}

async function inspectSetup(
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

async function updateServiceTokenDuration(
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

async function rotateServiceToken(
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

async function persistSetupState(operation: () => Promise<void>): Promise<void> {
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
