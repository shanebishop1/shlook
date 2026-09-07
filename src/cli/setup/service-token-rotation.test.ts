// @vitest-environment node
import { expect, test, vi } from "vitest";

import {
  applySetup,
  planSetup,
  type SetupDeploymentManifest,
  type SetupResourceKey,
} from "../../cli-setup.ts";
import {
  ACCOUNT_ID,
  capturedError,
  envelope,
  existingStateResponse,
  harness,
  input,
  page,
} from "./cloudflare-test-harness.ts";
import { persistence } from "./persistence-test-harness.ts";

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
