// @vitest-environment node
import { expect, test, vi } from "vitest";

import { applySetup } from "../../cli-setup.ts";
import {
  ACCOUNT_ID,
  TOKEN,
  baseResponse,
  capturedError,
  envelope,
  harness,
  input,
} from "./cloudflare-test-harness.ts";
import { persistence } from "./persistence-test-harness.ts";

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
