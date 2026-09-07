// @vitest-environment node
import { expect, test } from "vitest";

import { applySetup, planSetup } from "../../cli-setup.ts";
import {
  ACCOUNT_ID,
  OTHER_ACCOUNT_ID,
  TOKEN,
  ZONE_ID,
  baseResponse,
  capturedError,
  contractPage,
  envelope,
  harness,
  input,
  page,
} from "./cloudflare-test-harness.ts";

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
