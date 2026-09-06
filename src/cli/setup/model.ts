export const MAX_RESPONSE_BYTES = 1_048_576;
export const MAX_PAGES = 100;
export const PAGE_SIZE = 100;

// Service tokens are deliberately short-lived: 2160 hours is 90 days.
export const SERVICE_TOKEN_DURATION = "2160h";
// Block automatic reuse during the final week so rotation can be handled explicitly.
export const SERVICE_TOKEN_NEAR_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

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

export interface NormalizedSetupInput {
  domain: string;
  ownerEmail: string;
  accountId?: string;
  origins: SetupOrigins;
}

export interface ExistingState {
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
