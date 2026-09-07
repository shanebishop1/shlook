// @vitest-environment node
import { expect, test } from "vitest";

import { applySetup, planSetup, type SetupDeploymentManifest } from "../../cli-setup.ts";
import {
  OTHER_ACCOUNT_ID,
  TOKEN,
  ZONE_ID,
  baseResponse,
  capturedError,
  envelope,
  existingStateResponse,
  harness,
  input,
  page,
} from "./cloudflare-test-harness.ts";
import { persistence } from "./persistence-test-harness.ts";

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
