// @vitest-environment node
import { expect, test, vi } from "vitest";

import {
  CloudflareSetupError,
  applySetup,
  planSetup,
  type ApplySetupInput,
  type CloudflareSetupDependencies,
  type SetupDeploymentManifest,
  type SetupPersistence,
  type SetupResourceKey,
} from "./cli-setup.ts";

const ACCOUNT_ID = "a".repeat(32);
const OTHER_ACCOUNT_ID = "c".repeat(32);
const ZONE_ID = "b".repeat(32);
const TOKEN = "bootstrap-token-value";

interface RecordedRequest {
  body?: unknown;
  headers: Headers;
  method: string;
  redirect?: "error" | "follow" | "manual";
  url: URL;
}

function envelope(result: unknown, init?: ResponseInit): Response {
  return Response.json({ success: true, errors: [], messages: [], result }, init);
}

function page(result: unknown[], pageNumber = 1, totalPages = 1): Response {
  return Response.json({
    success: true,
    errors: [],
    messages: [],
    result,
    result_info: {
      page: pageNumber,
      per_page: 100,
      total_pages: totalPages,
      count: result.length,
      total_count: result.length,
    },
  });
}

function contractPage(
  result: unknown[],
  pageNumber: number,
  perPage: number,
  totalCount: number,
): Response {
  return Response.json({
    success: true,
    errors: [],
    messages: [],
    result,
    result_info: {
      page: pageNumber,
      per_page: perPage,
      count: result.length,
      total_count: totalCount,
    },
  });
}

function baseResponse(url: URL): Response {
  if (url.pathname === "/client/v4/user/tokens/verify") return envelope({ status: "active" });
  if (url.pathname === "/client/v4/memberships") {
    return page([
      {
        id: "membership-id",
        status: "accepted",
        account: { id: ACCOUNT_ID, name: "Primary account" },
      },
    ]);
  }
  if (url.pathname === "/client/v4/zones") {
    return page([
      { id: ZONE_ID, name: "example.com", status: "active", account: { id: ACCOUNT_ID } },
    ]);
  }
  if (url.pathname.endsWith("/d1/database")) return page([]);
  if (url.pathname.endsWith("/r2/buckets")) return envelope({ buckets: [] });
  if (url.pathname.endsWith("/access/apps")) return page([]);
  if (url.pathname.endsWith("/access/service_tokens")) return page([]);
  if (url.pathname.endsWith("/workers/services/shlook")) return new Response(null, { status: 404 });
  if (url.pathname.endsWith("/workers/domains")) return envelope([]);
  throw new Error(`unhandled test request: ${url.pathname}`);
}

function harness(
  handler: (request: RecordedRequest) => Response | Promise<Response> = ({ url }) =>
    baseResponse(url),
  env: Record<string, string | undefined> = { CLOUDFLARE_API_TOKEN: TOKEN },
): { dependencies: CloudflareSetupDependencies; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request: RecordedRequest = {
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      redirect: init?.redirect,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    requests.push(request);
    return handler(request);
  });
  return { dependencies: { env, fetch }, requests };
}

const input: ApplySetupInput = { domain: "example.com", ownerEmail: "owner@example.com" };

function persistence(overrides: Partial<SetupPersistence> = {}): SetupPersistence {
  return {
    saveIntent: vi.fn(async () => undefined),
    saveResource: vi.fn(async () => undefined),
    beginServiceTokenRotation: vi.fn(async () => undefined),
    saveServiceToken: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function capturedError(operation: Promise<unknown>): Promise<CloudflareSetupError> {
  try {
    await operation;
  } catch (cause) {
    expect(cause).toBeInstanceOf(CloudflareSetupError);
    return cause as CloudflareSetupError;
  }
  throw new Error("expected operation to reject");
}

test("uses the standard bootstrap token, supports the alias, and rejects conflicts", async () => {
  const standard = harness();
  await planSetup(input, standard.dependencies);
  expect(standard.requests[0].headers.get("authorization")).toBe(`Bearer ${TOKEN}`);

  const alias = harness(({ url }) => baseResponse(url), { SHLOOK_CF_TOKEN: "alias-token" });
  await planSetup(input, alias.dependencies);
  expect(alias.requests[0].headers.get("authorization")).toBe("Bearer alias-token");

  const equal = harness(({ url }) => baseResponse(url), {
    CLOUDFLARE_API_TOKEN: TOKEN,
    SHLOOK_CF_TOKEN: TOKEN,
  });
  await planSetup(input, equal.dependencies);
  expect(equal.requests[0].headers.get("authorization")).toBe(`Bearer ${TOKEN}`);

  const conflicting = harness(vi.fn(), {
    CLOUDFLARE_API_TOKEN: "standard-secret",
    SHLOOK_CF_TOKEN: "different-secret",
  });
  const error = await capturedError(planSetup(input, conflicting.dependencies));
  expect(error).toMatchObject({
    code: "bootstrap_token_conflict",
    message: "conflicting Cloudflare bootstrap token environment variables",
  });
  expect(conflicting.requests).toEqual([]);
  expect(`${error.message}${JSON.stringify(error)}`).not.toContain("standard-secret");
  expect(`${error.message}${JSON.stringify(error)}`).not.toContain("different-secret");
});

test("validates domain, owner email, account ID, and missing token before network access", async () => {
  const cases: Array<[ApplySetupInput, Record<string, string | undefined>, string]> = [
    [
      { ...input, domain: "https://example.com" },
      { CLOUDFLARE_API_TOKEN: TOKEN },
      "invalid_domain",
    ],
    [{ ...input, domain: "example.com/path" }, { CLOUDFLARE_API_TOKEN: TOKEN }, "invalid_domain"],
    [{ ...input, domain: "127.0.0.1" }, { CLOUDFLARE_API_TOKEN: TOKEN }, "invalid_domain"],
    [
      { ...input, ownerEmail: "not-an-email" },
      { CLOUDFLARE_API_TOKEN: TOKEN },
      "invalid_owner_email",
    ],
    [
      { ...input, ownerEmail: "a..b@example.com" },
      { CLOUDFLARE_API_TOKEN: TOKEN },
      "invalid_owner_email",
    ],
    [{ ...input, accountId: "short" }, { CLOUDFLARE_API_TOKEN: TOKEN }, "invalid_account_id"],
    [input, {}, "bootstrap_token_required"],
  ];
  for (const [invalidInput, env, code] of cases) {
    const context = harness(vi.fn(), env);
    expect((await capturedError(planSetup(invalidInput, context.dependencies))).code).toBe(code);
    expect(context.requests).toEqual([]);
  }
});

test("plan verifies identity, probes every read surface, and never mutates", async () => {
  const context = harness();
  const plan = await planSetup(input, context.dependencies);

  expect(plan).toMatchObject({
    mode: "plan",
    ready: true,
    account: { id: ACCOUNT_ID, name: "Primary account" },
    zone: { id: ZONE_ID, name: "example.com" },
    origins: {
      owner: "https://shlook.example.com",
      private: "https://private.example.com",
      public: "https://public.example.com",
      share: "https://share.example.com",
    },
    capabilities: {
      d1: { status: "available" },
      r2: { status: "available" },
      accessApplications: { status: "available" },
      accessServiceTokens: { status: "available" },
      workersServices: { status: "available" },
      workersDomains: { status: "available" },
    },
  });
  expect(plan.actions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ resource: "d1", operation: "create", name: "shlook" }),
      expect.objectContaining({ resource: "r2", operation: "create", name: "shlook-assets" }),
      expect.objectContaining({
        resource: "access_application",
        operation: "create",
        surface: "owner",
      }),
      expect.objectContaining({
        resource: "access_service_token",
        operation: "create",
        name: "shlook",
      }),
      expect.objectContaining({ resource: "workers_domains", operation: "controller" }),
    ]),
  );
  expect(context.requests.every((request) => request.method === "GET")).toBe(true);
  expect(context.requests.map((request) => request.url.pathname)).toEqual(
    expect.arrayContaining([
      "/client/v4/user/tokens/verify",
      "/client/v4/memberships",
      "/client/v4/zones",
      `/client/v4/accounts/${ACCOUNT_ID}/d1/database`,
      `/client/v4/accounts/${ACCOUNT_ID}/r2/buckets`,
      `/client/v4/accounts/${ACCOUNT_ID}/access/apps`,
      `/client/v4/accounts/${ACCOUNT_ID}/access/service_tokens`,
      `/client/v4/accounts/${ACCOUNT_ID}/workers/services/shlook`,
      `/client/v4/accounts/${ACCOUNT_ID}/workers/domains`,
    ]),
  );
  for (const request of context.requests) {
    expect(request.url.origin).toBe("https://api.cloudflare.com");
    expect(request.redirect).toBe("manual");
    expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(request.headers.has("x-auth-email")).toBe(false);
    expect(request.headers.has("x-auth-key")).toBe(false);
  }
  expect(JSON.stringify(plan)).not.toContain(TOKEN);
});

test("maps denied and unavailable probes to stable capability statuses", async () => {
  const context = harness(({ url }) => {
    if (url.pathname.endsWith("/d1/database")) {
      return Response.json({ errors: [{ message: `denied ${TOKEN}` }] }, { status: 403 });
    }
    if (url.pathname.endsWith("/r2/buckets")) return new Response("missing", { status: 404 });
    if (url.pathname.endsWith("/workers/domains"))
      return new Response("slow down", { status: 429 });
    return baseResponse(url);
  });
  const plan = await planSetup(input, context.dependencies);

  expect(plan.ready).toBe(false);
  expect(plan.capabilities.d1).toEqual({ status: "missing_permission", httpStatus: 403 });
  expect(plan.capabilities.r2).toEqual({ status: "unavailable", httpStatus: 404 });
  expect(plan.capabilities.workersDomains).toEqual({ status: "rate_limited", httpStatus: 429 });
  expect(JSON.stringify(plan)).not.toContain(TOKEN);

  const error = await capturedError(applySetup(input, context.dependencies));
  expect(error).toMatchObject({
    code: "setup_capabilities_unavailable",
    message: "required Cloudflare setup capabilities are unavailable",
  });
  expect(error.message).not.toContain(TOKEN);
});

test("selects the exact accepted account and exact active zone", async () => {
  const context = harness(({ url }) => {
    if (url.pathname === "/client/v4/memberships") {
      return page([
        { status: "accepted", account: { id: OTHER_ACCOUNT_ID, name: "Other" } },
        { status: "pending", account: { id: ACCOUNT_ID, name: "Pending" } },
        { status: "accepted", account: { id: ACCOUNT_ID, name: "Selected" } },
      ]);
    }
    if (url.pathname === "/client/v4/zones") {
      return page([
        { id: "d".repeat(32), name: "other.com", status: "active", account: { id: ACCOUNT_ID } },
        { id: "e".repeat(32), name: "example.com", status: "pending", account: { id: ACCOUNT_ID } },
        { id: ZONE_ID, name: "example.com", status: "active", account: { id: ACCOUNT_ID } },
      ]);
    }
    return baseResponse(url);
  });
  const plan = await planSetup({ ...input, accountId: ACCOUNT_ID }, context.dependencies);
  expect(plan.account).toEqual({ id: ACCOUNT_ID, name: "Selected" });
  expect(plan.zone).toEqual({ id: ZONE_ID, name: "example.com" });
  const zoneRequest = context.requests.find((request) => request.url.pathname.endsWith("/zones"));
  expect(zoneRequest?.url.searchParams.get("name")).toBe("example.com");
  expect(zoneRequest?.url.searchParams.get("account.id")).toBe(ACCOUNT_ID);
  expect(zoneRequest?.url.searchParams.get("status")).toBe("active");

  const ambiguous = harness(({ url }) => {
    if (url.pathname === "/client/v4/memberships") {
      return page([
        { status: "accepted", account: { id: ACCOUNT_ID, name: "First" } },
        { status: "accepted", account: { id: OTHER_ACCOUNT_ID, name: "Second" } },
      ]);
    }
    return baseResponse(url);
  });
  expect((await capturedError(planSetup(input, ambiguous.dependencies))).code).toBe(
    "account_ambiguous",
  );
});

test("paginates contract-shaped responses without total_pages", async () => {
  const context = harness(({ url }) => {
    if (url.pathname === "/client/v4/memberships") {
      const current = Number(url.searchParams.get("page"));
      return current === 1
        ? contractPage(
            [{ status: "pending", account: { id: OTHER_ACCOUNT_ID, name: "Pending" } }],
            1,
            1,
            2,
          )
        : contractPage(
            [{ status: "accepted", account: { id: ACCOUNT_ID, name: "Second page" } }],
            2,
            1,
            2,
          );
    }
    return baseResponse(url);
  });
  expect((await planSetup(input, context.dependencies)).account.name).toBe("Second page");
  expect(
    context.requests.filter((request) => request.url.pathname.endsWith("/memberships")),
  ).toHaveLength(2);
});

test("uses documented point queries for Workers discovery and treats only service 404 as absence", async () => {
  const context = harness(({ url }) => {
    if (url.pathname.endsWith("/workers/domains")) {
      return url.searchParams.get("hostname") === "shlook.example.com"
        ? envelope([
            {
              id: "owner-domain-id",
              hostname: "shlook.example.com",
              zone_id: ZONE_ID,
              service: "shlook",
            },
          ])
        : envelope([]);
    }
    return baseResponse(url);
  });

  const plan = await planSetup({ ...input, adoptExisting: true }, context.dependencies);
  expect(plan.deploymentManifest.resources.workers_domain_owner).toEqual({
    action: "adopt",
    name: "shlook.example.com",
    id: "owner-domain-id",
  });

  const requests = context.requests.filter((request) =>
    request.url.pathname.endsWith("/workers/domains"),
  );
  expect(requests).toHaveLength(4);
  expect(requests.map((request) => request.url.searchParams.get("hostname"))).toEqual([
    "shlook.example.com",
    "private.example.com",
    "public.example.com",
    "share.example.com",
  ]);
  expect(requests.every((request) => request.url.searchParams.get("zone_id") === ZONE_ID)).toBe(
    true,
  );
  expect(requests.every((request) => !request.url.searchParams.has("page"))).toBe(true);
  expect(
    context.requests.filter((request) => request.url.pathname.endsWith("/workers/services/shlook")),
  ).toHaveLength(1);
  expect(plan.capabilities.workersServices).toEqual({ status: "available" });

  const denied = harness(({ url }) =>
    url.pathname.endsWith("/workers/services/shlook")
      ? new Response(null, { status: 403 })
      : baseResponse(url),
  );
  const deniedPlan = await planSetup(input, denied.dependencies);
  expect(deniedPlan.capabilities.workersServices).toEqual({
    status: "missing_permission",
    httpStatus: 403,
  });
});

function existingStateResponse(url: URL): Response {
  const ownerApp = {
    id: "owner-app-id",
    name: "shlook-owner",
    domain: "shlook.example.com",
    type: "self_hosted",
  };
  const privateApp = {
    id: "private-app-id",
    name: "shlook-private",
    domain: "private.example.com",
    type: "self_hosted",
  };
  if (url.pathname.endsWith("/d1/database")) {
    return page([{ uuid: "database-id", name: "shlook" }]);
  }
  if (url.pathname.endsWith("/r2/buckets")) {
    return envelope({ buckets: [{ name: "shlook-assets" }] });
  }
  if (url.pathname.endsWith("/access/apps")) return page([ownerApp, privateApp]);
  if (url.pathname.endsWith("/access/service_tokens")) {
    return page([
      {
        id: "token-id",
        name: "shlook",
        client_id: "client-id",
        enabled: true,
        expires_at: "2099-01-01T00:00:00.000Z",
      },
    ]);
  }
  if (url.pathname.endsWith("/access/apps/owner-app-id/policies")) {
    return page([
      {
        id: "owner-email-policy-id",
        name: "shlook-owner-email",
        decision: "allow",
        include: [{ email: { email: "owner@example.com" } }],
      },
      {
        id: "owner-token-policy-id",
        name: "shlook-service-token",
        decision: "non_identity",
        include: [{ service_token: { token_id: "token-id" } }],
      },
    ]);
  }
  if (url.pathname.endsWith("/access/apps/private-app-id/policies")) {
    return page([
      {
        id: "private-email-policy-id",
        name: "shlook-owner-email",
        decision: "allow",
        include: [{ email: { email: "owner@example.com" } }],
      },
      {
        id: "private-token-policy-id",
        name: "shlook-service-token",
        decision: "non_identity",
        include: [{ service_token: { token_id: "token-id" } }],
      },
    ]);
  }
  return baseResponse(url);
}

test("reuses exact existing resources and policies without mutation", async () => {
  const context = harness(({ url }) => existingStateResponse(url));
  const refusal = await capturedError(planSetup(input, context.dependencies));
  expect(refusal).toMatchObject({ code: "setup_resource_collision" });
  expect(context.requests.every((request) => request.method === "GET")).toBe(true);

  const adoptedPlan = await planSetup({ ...input, adoptExisting: true }, context.dependencies);
  expect(adoptedPlan.deploymentManifest.resources.d1).toMatchObject({
    action: "adopt",
    id: "database-id",
  });
  expect(adoptedPlan.actions).toContainEqual(
    expect.objectContaining({ resource: "d1", operation: "adopt", id: "database-id" }),
  );
  const result = await applySetup(
    {
      ...input,
      deploymentManifest: adoptedPlan.deploymentManifest,
      persistence: persistence(),
      existingServiceToken: { clientId: "client-id", clientSecret: "known-secret" },
    },
    context.dependencies,
  );

  expect(context.requests.every((request) => request.method === "GET")).toBe(true);
  expect(result.resources).toMatchObject({
    d1: { id: "database-id", name: "shlook", created: false },
    r2: { id: "shlook-assets", name: "shlook-assets", created: false },
    accessApplications: {
      owner: { id: "owner-app-id", created: false },
      private: { id: "private-app-id", created: false },
    },
    accessServiceToken: { id: "token-id", clientId: "client-id", created: false },
  });
  expect(result.createdServiceTokenCredentials).toBeUndefined();
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(TOKEN);
  expect(serialized).not.toContain("known-secret");
});

test("fails closed when a deployment manifest target or resource ID does not match", async () => {
  const context = harness(({ url }) => existingStateResponse(url));
  const adopted = await planSetup({ ...input, adoptExisting: true }, context.dependencies);
  const wrongAccount: SetupDeploymentManifest = {
    ...adopted.deploymentManifest,
    accountId: OTHER_ACCOUNT_ID,
  };
  expect(
    (
      await capturedError(
        planSetup({ ...input, deploymentManifest: wrongAccount }, context.dependencies),
      )
    ).code,
  ).toBe("setup_manifest_mismatch");

  const wrongD1: SetupDeploymentManifest = {
    ...adopted.deploymentManifest,
    resources: {
      ...adopted.deploymentManifest.resources,
      d1: { ...adopted.deploymentManifest.resources.d1, id: "wrong-database-id" },
    },
  };
  expect(
    (
      await capturedError(
        planSetup({ ...input, deploymentManifest: wrongD1 }, context.dependencies),
      )
    ).code,
  ).toBe("setup_manifest_mismatch");
  expect(context.requests.every((request) => request.method === "GET")).toBe(true);
});

test("rejects Worker service and custom-domain ownership conflicts before mutation", async () => {
  for (const conflict of ["worker", "domain"] as const) {
    const context = harness(({ url }) => {
      if (conflict === "worker" && url.pathname.endsWith("/workers/services/shlook")) {
        return envelope({ id: "shlook", default_environment: { environment: "production" } });
      }
      if (
        conflict === "domain" &&
        url.pathname.endsWith("/workers/domains") &&
        url.searchParams.get("hostname") === "shlook.example.com"
      ) {
        return envelope([
          {
            id: "foreign-domain-id",
            hostname: "shlook.example.com",
            zone_id: ZONE_ID,
            service: "unrelated-worker",
          },
        ]);
      }
      return baseResponse(url);
    });

    const error = await capturedError(planSetup(input, context.dependencies));
    expect(error.code).toBe(
      conflict === "worker" ? "setup_resource_collision" : "setup_resource_conflict",
    );
    expect(context.requests.every((request) => request.method === "GET")).toBe(true);
  }
});

test("adopts the exact named Worker only with the explicit dangerous flag", async () => {
  const context = harness(({ url }) =>
    url.pathname.endsWith("/workers/services/shlook")
      ? envelope({ id: "shlook", default_environment: { environment: "production" } })
      : baseResponse(url),
  );
  const plan = await planSetup({ ...input, adoptExisting: true }, context.dependencies);
  expect(plan.actions).toContainEqual({
    resource: "worker_service",
    operation: "adopt",
    name: "shlook",
    id: "shlook",
  });
  expect(plan.deploymentManifest.resources.worker_service).toEqual({
    action: "adopt",
    name: "shlook",
    id: "shlook",
  });
});

test.each([
  {
    label: "another Service Auth policy",
    surface: "owner",
    policy: {
      id: "other-machine-policy-id",
      name: "other-machine",
      decision: "non_identity",
      include: [{ service_token: { token_id: "other-token-id" } }],
    },
  },
  {
    label: "an any-valid-service-token policy",
    surface: "owner",
    policy: {
      id: "any-token-policy-id",
      name: "any-token",
      decision: "allow",
      include: [{ any_valid_service_token: {} }],
    },
  },
  {
    label: "a bypass policy",
    surface: "private",
    policy: {
      id: "bypass-policy-id",
      name: "bypass-machines",
      decision: "bypass",
      include: [{ everyone: {} }],
    },
  },
])("fails closed when a reused Access app has $label", async ({ policy, surface }) => {
  const context = harness(({ url }) => {
    if (url.pathname.endsWith(`/access/apps/${surface}-app-id/policies`)) {
      return page([
        {
          id: `${surface}-email-policy-id`,
          name: "shlook-owner-email",
          decision: "allow",
          include: [{ email: { email: "owner@example.com" } }],
        },
        {
          id: `${surface}-token-policy-id`,
          name: "shlook-service-token",
          decision: "non_identity",
          include: [{ service_token: { token_id: "token-id" } }],
        },
        policy,
      ]);
    }
    return existingStateResponse(url);
  });

  const error = await capturedError(planSetup(input, context.dependencies));

  expect(error).toMatchObject({
    code: "setup_resource_conflict",
    message: "an existing Cloudflare resource conflicts with the required shlook setup",
  });
  expect(context.requests.every((request) => request.method === "GET")).toBe(true);
});

test("rejects expired service tokens and renews manifest-owned near-expiry tokens without duplicates", async () => {
  let renewed = false;
  const tokenResponse = (expiresAt: string) =>
    harness(({ url, method, body }) => {
      if (url.pathname.endsWith("/access/service_tokens")) {
        return page([
          {
            id: "token-id",
            name: "shlook",
            client_id: "client-id",
            enabled: true,
            expires_at: expiresAt,
          },
        ]);
      }
      if (url.pathname.endsWith("/access/service_tokens/token-id") && method === "PUT") {
        expect(body).toEqual({ name: "shlook", duration: "2160h" });
        renewed = true;
        return envelope({
          id: "token-id",
          name: "shlook",
          client_id: "client-id",
          duration: "2160h",
          expires_at: "2099-01-01T00:00:00.000Z",
        });
      }
      if (url.pathname.endsWith("/access/service_tokens/token-id/rotate") && method === "POST") {
        expect(body).toBeUndefined();
        return envelope({
          id: "token-id",
          name: "shlook",
          client_id: "client-id",
          client_secret: "renewed-secret",
          duration: "2160h",
        });
      }
      return existingStateResponse(url);
    });

  const expired = tokenResponse("2000-01-01T00:00:00.000Z");
  expect((await capturedError(planSetup(input, expired.dependencies))).code).toBe(
    "setup_resource_conflict",
  );
  expect(expired.requests.every((request) => request.method === "GET")).toBe(true);

  const nearExpiry = tokenResponse(new Date(Date.now() + 60 * 60 * 1000).toISOString());
  const plan = await planSetup({ ...input, adoptExisting: true }, nearExpiry.dependencies);
  expect(plan.ready).toBe(false);
  expect(plan.actions).toContainEqual({
    resource: "access_service_token",
    operation: "blocked",
    name: "shlook",
    id: "token-id",
    reason: "service_token_expiring",
  });

  const statePersistence = persistence();
  const result = await applySetup(
    {
      ...input,
      deploymentManifest: plan.deploymentManifest,
      persistence: statePersistence,
      existingServiceToken: { clientId: "client-id", clientSecret: "known-secret" },
    },
    nearExpiry.dependencies,
  );
  expect(renewed).toBe(true);
  expect(statePersistence.beginServiceTokenRotation).toHaveBeenCalledWith("token-id", "client-id");
  expect(statePersistence.saveServiceToken).toHaveBeenCalledWith({
    resourceId: "token-id",
    clientId: "client-id",
    clientSecret: "renewed-secret",
  });
  expect(result.createdServiceTokenCredentials).toEqual({
    clientId: "client-id",
    clientSecret: "renewed-secret",
  });
  const tokenMutations = nearExpiry.requests.filter(
    (request) => request.method !== "GET" && request.url.pathname.includes("/service_tokens"),
  );
  expect(tokenMutations.map((request) => [request.method, request.url.pathname])).toEqual([
    ["PUT", `/client/v4/accounts/${ACCOUNT_ID}/access/service_tokens/token-id`],
    ["POST", `/client/v4/accounts/${ACCOUNT_ID}/access/service_tokens/token-id/rotate`],
  ]);
});

test("does not rotate again when a journaled renewal already persisted its new secret", async () => {
  const context = harness(({ url }) => {
    if (url.pathname.endsWith("/access/service_tokens")) {
      return page([
        {
          id: "token-id",
          name: "shlook",
          client_id: "client-id",
          enabled: true,
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      ]);
    }
    return existingStateResponse(url);
  });
  const plan = await planSetup({ ...input, adoptExisting: true }, context.dependencies);
  context.requests.length = 0;

  const result = await applySetup(
    {
      ...input,
      deploymentManifest: plan.deploymentManifest,
      existingServiceToken: { clientId: "client-id", clientSecret: "rotated-secret" },
      serviceTokenRotationCompleted: true,
      persistence: persistence(),
    },
    context.dependencies,
  );

  expect(result.resources.accessServiceToken).toMatchObject({
    id: "token-id",
    clientId: "client-id",
    created: false,
  });
  expect(result.createdServiceTokenCredentials).toBeUndefined();
  expect(context.requests.every((request) => request.method === "GET")).toBe(true);
});

test("recovers a lost service-token create response from exact persisted create intent", async () => {
  let remoteTokenExists = false;
  let loseCreateResponse = true;
  const savedTokens: unknown[] = [];
  let persistedManifest: SetupDeploymentManifest | undefined;
  const context = harness(({ url, method, body }) => {
    if (method === "GET" && url.pathname.endsWith("/access/service_tokens")) {
      return page(
        remoteTokenExists
          ? [
              {
                id: "token-id",
                name: "shlook",
                client_id: "client-id",
                enabled: true,
                expires_at: "2099-01-01T00:00:00.000Z",
              },
            ]
          : [],
      );
    }
    if (method === "GET" && url.pathname.endsWith("/policies")) return page([]);
    if (method === "POST" && url.pathname.endsWith("/access/service_tokens")) {
      expect(body).toEqual({ name: "shlook", duration: "2160h" });
      remoteTokenExists = true;
      if (loseCreateResponse) {
        loseCreateResponse = false;
        throw new Error("response lost after provider create");
      }
    }
    if (method === "POST" && url.pathname.endsWith("/access/service_tokens/token-id/rotate")) {
      return envelope({
        id: "token-id",
        name: "shlook",
        client_id: "client-id",
        client_secret: "recovered-secret",
        duration: "2160h",
      });
    }
    if (method === "POST" && url.pathname.endsWith("/policies")) {
      return envelope({ ...(body as object), id: `policy-${context.requests.length}` });
    }
    return existingStateResponse(url);
  });
  const initialPlan = await planSetup({ ...input, adoptExisting: true }, context.dependencies);
  expect(initialPlan.deploymentManifest.resources.access_service_token).toEqual({
    action: "create",
    name: "shlook",
  });
  const statePersistence = persistence({
    saveIntent: vi.fn(async (manifest) => {
      persistedManifest = manifest;
    }),
    saveResource: vi.fn(async (resource: SetupResourceKey, id: string) => {
      if (persistedManifest === undefined) throw new Error("manifest missing");
      persistedManifest = {
        ...persistedManifest,
        resources: {
          ...persistedManifest.resources,
          [resource]: { ...persistedManifest.resources[resource], id },
        },
      };
    }),
    saveServiceToken: vi.fn(async (token) => {
      savedTokens.push(token);
    }),
  });

  await expect(
    applySetup(
      {
        ...input,
        deploymentManifest: initialPlan.deploymentManifest,
        persistence: statePersistence,
      },
      context.dependencies,
    ),
  ).rejects.toMatchObject({ code: "cloudflare_request_failed" });
  expect(persistedManifest?.resources.access_service_token.id).toBeUndefined();

  const result = await applySetup(
    { ...input, deploymentManifest: persistedManifest!, persistence: statePersistence },
    context.dependencies,
  );
  expect(result.resources.accessServiceToken).toMatchObject({
    id: "token-id",
    clientId: "client-id",
    created: false,
  });
  expect(savedTokens).toEqual([
    { resourceId: "token-id", clientId: "client-id", clientSecret: "recovered-secret" },
  ]);
  expect(persistedManifest?.resources.access_service_token).toEqual({
    action: "create",
    name: "shlook",
    id: "token-id",
  });
  expect(
    context.requests.filter(
      (request) =>
        request.method === "POST" && request.url.pathname.endsWith("/access/service_tokens"),
    ),
  ).toHaveLength(1);
  expect(
    context.requests.filter((request) => request.url.pathname.endsWith("/token-id/rotate")),
  ).toHaveLength(1);
});

test.each(["lost create response", "lost state write"] as const)(
  "recovers an interrupted D1 creation after a %s",
  async (failureMode) => {
    let remoteD1Exists = false;
    let failD1StateWrite = failureMode === "lost state write";
    let persistedManifest: SetupDeploymentManifest | undefined;
    const context = harness(({ url, method, body }) => {
      if (url.pathname.endsWith("/d1/database")) {
        if (method === "GET") {
          return page(remoteD1Exists ? [{ uuid: "database-id", name: "shlook" }] : []);
        }
        expect(body).toEqual({ name: "shlook" });
        remoteD1Exists = true;
        if (failureMode === "lost create response") {
          throw new Error("response lost after provider create");
        }
        return envelope({ uuid: "database-id", name: "shlook" }, { status: 201 });
      }
      return existingStateResponse(url);
    });
    const initialPlan = await planSetup({ ...input, adoptExisting: true }, context.dependencies);
    expect(initialPlan.deploymentManifest.resources.d1).toEqual({
      action: "create",
      name: "shlook",
    });
    const statePersistence = persistence({
      saveIntent: vi.fn(async (manifest) => {
        persistedManifest = manifest;
      }),
      saveResource: vi.fn(async (resource: SetupResourceKey, id: string) => {
        if (resource === "d1" && failD1StateWrite) {
          failD1StateWrite = false;
          throw new Error("state write lost after provider create");
        }
        if (persistedManifest === undefined) throw new Error("manifest missing");
        persistedManifest = {
          ...persistedManifest,
          resources: {
            ...persistedManifest.resources,
            [resource]: { ...persistedManifest.resources[resource], id },
          },
        };
      }),
    });

    await expect(
      applySetup(
        {
          ...input,
          deploymentManifest: initialPlan.deploymentManifest,
          existingServiceToken: { clientId: "client-id", clientSecret: "known-secret" },
          persistence: statePersistence,
        },
        context.dependencies,
      ),
    ).rejects.toMatchObject({
      code:
        failureMode === "lost create response"
          ? "cloudflare_request_failed"
          : "setup_state_persistence_failed",
    });
    expect(persistedManifest?.resources.d1.id).toBeUndefined();

    await applySetup(
      {
        ...input,
        deploymentManifest: persistedManifest!,
        existingServiceToken: { clientId: "client-id", clientSecret: "known-secret" },
        persistence: statePersistence,
      },
      context.dependencies,
    );

    expect(persistedManifest?.resources.d1.id).toBe("database-id");
    expect(
      context.requests.filter(
        (request) => request.method === "POST" && request.url.pathname.endsWith("/d1/database"),
      ),
    ).toHaveLength(1);
  },
);

test.each([
  ["r2", "shlook-assets"],
  ["access_application_owner", "owner-app-id"],
  ["access_email_policy_owner", "owner-email-policy-id"],
  ["access_service_token_policy_private", "private-token-policy-id"],
] as const)(
  "persists a uniquely discovered exact %s interrupted-create resource before continuing",
  async (resource, id) => {
    const context = harness(({ url }) => existingStateResponse(url));
    const adopted = await planSetup({ ...input, adoptExisting: true }, context.dependencies);
    const interrupted: SetupDeploymentManifest = {
      ...adopted.deploymentManifest,
      resources: {
        ...adopted.deploymentManifest.resources,
        [resource]: {
          action: "create",
          name: adopted.deploymentManifest.resources[resource].name,
        },
      },
    };
    const statePersistence = persistence();

    await applySetup(
      {
        ...input,
        deploymentManifest: interrupted,
        existingServiceToken: { clientId: "client-id", clientSecret: "known-secret" },
        persistence: statePersistence,
      },
      context.dependencies,
    );

    expect(statePersistence.saveResource).toHaveBeenCalledWith(resource, id);
    expect(context.requests.every((request) => request.method === "GET")).toBe(true);
  },
);

test("rejects a mismatched resource despite persisted create-without-ID intent", async () => {
  const absent = harness();
  const initial = await planSetup(input, absent.dependencies);
  const mismatched = harness(({ url }) => {
    if (url.pathname.endsWith("/access/apps")) {
      return page([
        {
          id: "attacker-app-id",
          name: "shlook-owner",
          domain: "attacker.example.net",
          type: "self_hosted",
        },
      ]);
    }
    return baseResponse(url);
  });

  await expect(
    applySetup(
      { ...input, deploymentManifest: initial.deploymentManifest, persistence: persistence() },
      mismatched.dependencies,
    ),
  ).rejects.toMatchObject({ code: "setup_resource_conflict" });
  expect(mismatched.requests.every((request) => request.method === "GET")).toBe(true);
});

test("a failed pending save returns a stable recovery error and reruns the rotation", async () => {
  const context = harness(({ url, method }) => {
    if (method === "POST" && url.pathname.endsWith("/access/service_tokens/token-id/rotate")) {
      const attempt = context.requests.filter((request) =>
        request.url.pathname.endsWith("/access/service_tokens/token-id/rotate"),
      ).length;
      return envelope({
        id: "token-id",
        name: "shlook",
        client_id: "client-id",
        client_secret: `recovered-secret-${attempt}`,
        duration: "2160h",
      });
    }
    return existingStateResponse(url);
  });
  const adopted = await planSetup({ ...input, adoptExisting: true }, context.dependencies);
  let persistedManifest: SetupDeploymentManifest = {
    ...adopted.deploymentManifest,
    resources: {
      ...adopted.deploymentManifest.resources,
      access_service_token: { action: "create", name: "shlook" },
    },
  };
  let rejectPending = true;
  const statePersistence = persistence({
    saveResource: vi.fn(async (resource: SetupResourceKey, id: string) => {
      persistedManifest = {
        ...persistedManifest,
        resources: {
          ...persistedManifest.resources,
          [resource]: { ...persistedManifest.resources[resource], id },
        },
      };
    }),
    saveServiceToken: vi.fn(async () => {
      if (rejectPending) throw new Error("recovered-secret-1 must not leak");
    }),
  });

  const firstError = await capturedError(
    applySetup(
      { ...input, deploymentManifest: persistedManifest, persistence: statePersistence },
      context.dependencies,
    ),
  );
  expect(firstError).toMatchObject({
    code: "service_token_recovery_required",
    message:
      "Access service token credentials changed but could not be saved; rerun setup apply to recover",
  });
  expect(String(firstError)).not.toContain("recovered-secret-1");
  expect(persistedManifest.resources.access_service_token.id).toBe("token-id");

  rejectPending = false;
  const result = await applySetup(
    {
      ...input,
      deploymentManifest: persistedManifest,
      serviceTokenRotationPending: true,
      persistence: statePersistence,
    },
    context.dependencies,
  );
  expect(result.createdServiceTokenCredentials).toEqual({
    clientId: "client-id",
    clientSecret: "recovered-secret-2",
  });
  expect(
    context.requests.filter((request) => request.url.pathname.endsWith("/token-id/rotate")),
  ).toHaveLength(2);
  expect(
    context.requests.filter(
      (request) =>
        request.method === "POST" && request.url.pathname.endsWith("/access/service_tokens"),
    ),
  ).toHaveLength(0);
});

test("an interrupted near-expiry renewal resumes from its persisted rotation marker", async () => {
  let nearExpiry = true;
  let rejectPending = true;
  const context = harness(({ url, method }) => {
    if (method === "GET" && url.pathname.endsWith("/access/service_tokens")) {
      return page([
        {
          id: "token-id",
          name: "shlook",
          client_id: "client-id",
          enabled: true,
          expires_at: nearExpiry
            ? new Date(Date.now() + 60 * 60 * 1000).toISOString()
            : "2099-01-01T00:00:00.000Z",
        },
      ]);
    }
    if (method === "PUT" && url.pathname.endsWith("/access/service_tokens/token-id")) {
      nearExpiry = false;
      return envelope({
        id: "token-id",
        name: "shlook",
        client_id: "client-id",
        duration: "2160h",
        expires_at: "2099-01-01T00:00:00.000Z",
      });
    }
    if (method === "POST" && url.pathname.endsWith("/access/service_tokens/token-id/rotate")) {
      const attempt = context.requests.filter((request) =>
        request.url.pathname.endsWith("/rotate"),
      ).length;
      return envelope({
        id: "token-id",
        name: "shlook",
        client_id: "client-id",
        client_secret: `renewal-secret-${attempt}`,
        duration: "2160h",
      });
    }
    return existingStateResponse(url);
  });
  const plan = await planSetup({ ...input, adoptExisting: true }, context.dependencies);
  const statePersistence = persistence({
    saveServiceToken: vi.fn(async () => {
      if (rejectPending) throw new Error("pending write failed");
    }),
  });

  await expect(
    applySetup(
      {
        ...input,
        deploymentManifest: plan.deploymentManifest,
        existingServiceToken: { clientId: "client-id", clientSecret: "old-secret" },
        persistence: statePersistence,
      },
      context.dependencies,
    ),
  ).rejects.toMatchObject({ code: "service_token_recovery_required" });

  rejectPending = false;
  await applySetup(
    {
      ...input,
      deploymentManifest: plan.deploymentManifest,
      serviceTokenRotationPending: true,
      existingServiceToken: { clientId: "client-id", clientSecret: "old-secret" },
      persistence: statePersistence,
    },
    context.dependencies,
  );
  expect(
    context.requests.filter(
      (request) => request.method === "PUT" && request.url.pathname.endsWith("/token-id"),
    ),
  ).toHaveLength(1);
  expect(
    context.requests.filter((request) => request.url.pathname.endsWith("/token-id/rotate")),
  ).toHaveLength(2);
});

test("refuses an adopted service token without a recoverable secret before mutation", async () => {
  const context = harness(({ url }) => existingStateResponse(url));
  const plan = await planSetup({ ...input, adoptExisting: true }, context.dependencies);
  const error = await capturedError(
    applySetup(
      { ...input, deploymentManifest: plan.deploymentManifest, persistence: persistence() },
      context.dependencies,
    ),
  );

  expect(error).toMatchObject({
    code: "service_token_secret_unavailable",
    message: "the existing shlook Access service token secret cannot be recovered",
  });
  expect(context.requests.every((request) => request.method === "GET")).toBe(true);
});

test("creates resources in order and applies exact email and service-token policies", async () => {
  let mutationCountAtIntent = -1;
  let mutationCountAtSecretSink = -1;
  const context = harness(({ url, method, body }) => {
    if (method === "GET") return baseResponse(url);
    if (url.pathname.endsWith("/d1/database")) {
      expect(body).toEqual({ name: "shlook" });
      return envelope({ uuid: "database-id", name: "shlook" }, { status: 201 });
    }
    if (url.pathname.endsWith("/r2/buckets")) {
      expect(body).toEqual({ name: "shlook-assets" });
      return envelope({ name: "shlook-assets" }, { status: 201 });
    }
    if (url.pathname.endsWith("/access/apps")) {
      const app = body as { domain: string; name: string; type: string };
      return envelope({ ...app, id: `${app.name}-id` }, { status: 201 });
    }
    if (url.pathname.endsWith("/access/service_tokens")) {
      expect(body).toEqual({ name: "shlook", duration: "2160h" });
      return envelope(
        {
          id: "token-id",
          name: "shlook",
          client_id: "new-client-id",
          client_secret: "new-client-secret",
          enabled: true,
        },
        { status: 201 },
      );
    }
    if (url.pathname.endsWith("/policies")) {
      return envelope(
        { ...(body as object), id: `policy-${context.requests.length}` },
        { status: 201 },
      );
    }
    throw new Error(`unhandled mutation ${method} ${url.pathname}`);
  });
  const statePersistence = persistence({
    saveIntent: vi.fn(async () => {
      mutationCountAtIntent = context.requests.filter((request) => request.method !== "GET").length;
    }),
    saveServiceToken: vi.fn(async (pending) => {
      expect(pending).toMatchObject({
        resourceId: "token-id",
        clientId: "new-client-id",
        clientSecret: "new-client-secret",
      });
      mutationCountAtSecretSink = context.requests.filter(
        (request) => request.method !== "GET",
      ).length;
    }),
  });
  const result = await applySetup(
    { ...input, persistence: statePersistence },
    context.dependencies,
  );
  const mutations = context.requests.filter((request) => request.method !== "GET");

  expect(mutations.map((request) => request.url.pathname)).toEqual([
    `/client/v4/accounts/${ACCOUNT_ID}/d1/database`,
    `/client/v4/accounts/${ACCOUNT_ID}/r2/buckets`,
    `/client/v4/accounts/${ACCOUNT_ID}/access/apps`,
    `/client/v4/accounts/${ACCOUNT_ID}/access/apps`,
    `/client/v4/accounts/${ACCOUNT_ID}/access/service_tokens`,
    `/client/v4/accounts/${ACCOUNT_ID}/access/apps/shlook-owner-id/policies`,
    `/client/v4/accounts/${ACCOUNT_ID}/access/apps/shlook-owner-id/policies`,
    `/client/v4/accounts/${ACCOUNT_ID}/access/apps/shlook-private-id/policies`,
    `/client/v4/accounts/${ACCOUNT_ID}/access/apps/shlook-private-id/policies`,
  ]);
  expect(mutations.map((request) => request.method)).toEqual(Array(9).fill("POST"));
  expect(mutationCountAtIntent).toBe(0);
  expect(mutationCountAtSecretSink).toBe(5);
  expect(statePersistence.saveIntent).toHaveBeenCalledOnce();
  expect(mutations[2].body).toEqual({
    name: "shlook-owner",
    domain: "shlook.example.com",
    type: "self_hosted",
    session_duration: "24h",
  });
  expect(mutations[3].body).toEqual({
    name: "shlook-private",
    domain: "private.example.com",
    type: "self_hosted",
    session_duration: "24h",
  });
  expect(mutations[5].body).toEqual({
    name: "shlook-owner-email",
    decision: "allow",
    include: [{ email: { email: "owner@example.com" } }],
  });
  expect(mutations[6].body).toEqual({
    name: "shlook-service-token",
    decision: "non_identity",
    include: [{ service_token: { token_id: "token-id" } }],
  });
  expect(mutations[7].body).toEqual(mutations[5].body);
  expect(mutations[8].body).toEqual(mutations[6].body);
  expect(result.createdServiceTokenCredentials).toEqual({
    clientId: "new-client-id",
    clientSecret: "new-client-secret",
  });
  expect(result.resources.accessPolicies.owner.email.id).toBeTypeOf("string");
  expect(JSON.stringify(result)).not.toContain(TOKEN);
});

test("refuses all Cloudflare mutations unless the deployment intention can be persisted first", async () => {
  const missing = harness();
  const missingError = await capturedError(applySetup(input, missing.dependencies));
  expect(missingError.code).toBe("setup_state_persistence_required");
  expect(missing.requests.every((request) => request.method === "GET")).toBe(true);

  const rejected = harness();
  const secretValue = "pending-secret-must-not-leak";
  const rejectedError = await capturedError(
    applySetup(
      {
        ...input,
        persistence: persistence({
          saveIntent: vi.fn(async () => {
            throw new Error(secretValue);
          }),
        }),
      },
      rejected.dependencies,
    ),
  );
  expect(rejectedError).toMatchObject({ code: "setup_state_persistence_failed" });
  expect(String(rejectedError)).not.toContain(secretValue);
  expect(rejected.requests.every((request) => request.method === "GET")).toBe(true);
});

test("rejects redirect responses and never forwards authorization", async () => {
  const context = harness(
    () =>
      new Response(null, { status: 302, headers: { location: "https://attacker.invalid/steal" } }),
  );
  const error = await capturedError(planSetup(input, context.dependencies));
  expect(error).toMatchObject({
    code: "cloudflare_redirect_rejected",
    message: "Cloudflare API redirects are not allowed",
    status: 302,
  });
  expect(context.requests).toHaveLength(1);
  expect(context.requests[0].redirect).toBe("manual");
});

test("returns stable errors without leaking bootstrap tokens or provider bodies", async () => {
  const network = harness(() => {
    throw new Error(`socket failed with ${TOKEN}`);
  });
  const networkError = await capturedError(planSetup(input, network.dependencies));
  expect(networkError).toMatchObject({
    code: "cloudflare_request_failed",
    message: "Cloudflare API request failed",
  });
  expect(networkError.message).not.toContain(TOKEN);

  const denied = harness(() =>
    Response.json({ success: false, errors: [{ message: `bad ${TOKEN}` }] }, { status: 401 }),
  );
  const deniedError = await capturedError(planSetup(input, denied.dependencies));
  expect(deniedError).toMatchObject({
    code: "cloudflare_authentication_failed",
    message: "Cloudflare bootstrap token verification failed",
    status: 401,
  });
  expect(`${deniedError.message}${JSON.stringify(deniedError)}`).not.toContain(TOKEN);
});

test("rejects malformed and oversized Cloudflare responses with bounded generic errors", async () => {
  const malformedJson = harness(
    () => new Response("{not-json", { headers: { "content-type": "application/json" } }),
  );
  expect((await capturedError(planSetup(input, malformedJson.dependencies))).code).toBe(
    "cloudflare_response_invalid",
  );

  const malformedEnvelope = harness(() => Response.json({ success: true, result: "wrong" }));
  expect((await capturedError(planSetup(input, malformedEnvelope.dependencies))).code).toBe(
    "cloudflare_response_invalid",
  );

  const malformedMembership = harness(({ url }) => {
    if (url.pathname === "/client/v4/memberships") {
      return page([
        {
          status: "accepted",
          account: { id: "../../not-an-account", name: "Malformed" },
        },
      ]);
    }
    return baseResponse(url);
  });
  expect((await capturedError(planSetup(input, malformedMembership.dependencies))).code).toBe(
    "cloudflare_response_invalid",
  );

  const oversized = harness(
    () =>
      new Response("x".repeat(1_048_577), {
        headers: { "content-type": "application/json", "content-length": "1048577" },
      }),
  );
  const oversizedError = await capturedError(planSetup(input, oversized.dependencies));
  expect(oversizedError).toMatchObject({
    code: "cloudflare_response_too_large",
    message: "Cloudflare API response exceeded the allowed size",
  });
});
