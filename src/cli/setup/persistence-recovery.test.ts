// @vitest-environment node
import { expect, test, vi } from "vitest";

import {
  applySetup,
  planSetup,
  type SetupDeploymentManifest,
  type SetupResourceKey,
} from "../../cli-setup.ts";
import {
  baseResponse,
  envelope,
  existingStateResponse,
  harness,
  input,
  page,
} from "./cloudflare-test-harness.ts";
import { persistence } from "./persistence-test-harness.ts";

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
