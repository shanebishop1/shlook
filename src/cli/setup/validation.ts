import {
  CLOUDFLARE_SETUP_NAMES,
  CloudflareSetupError,
  type ExistingServiceTokenCredentials,
  type ExistingState,
  type NormalizedSetupInput,
  type SetupAccount,
  type SetupInput,
  type SetupResourceKey,
  type SetupZone,
} from "./model.ts";
import {
  exactOne,
  hasControlCharacter,
  manifestMismatch,
  nonemptyString,
  resourceCollision,
  resourceKey,
} from "./shared.ts";

function isIpv4Address(value: string): boolean {
  const labels = value.split(".");
  return (
    labels.length === 4 &&
    labels.every(
      (label) => /^(0|[1-9][0-9]{0,2})$/.test(label) && Number(label) >= 0 && Number(label) <= 255,
    )
  );
}

export function normalizeInput(input: SetupInput): NormalizedSetupInput {
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

export function bootstrapToken(env: Record<string, string | undefined>): string {
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

export function validateExistingCredentials(
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

export function interruptedResourceCreate(input: SetupInput, key: SetupResourceKey): boolean {
  const expected = input.deploymentManifest?.resources[key];
  return (
    expected !== undefined &&
    expected.action === "create" &&
    expected.id === undefined &&
    Object.keys(expected).length === 2
  );
}

export function validateDeploymentOwnership(
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
