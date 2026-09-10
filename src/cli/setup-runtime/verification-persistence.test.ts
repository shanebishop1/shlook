// @vitest-environment node
import { expect, test, vi } from "vitest";

import type { ApplySetupInput } from "../../cli-setup.ts";
import { SetupRuntimeError, applySetupRuntime } from "../../cli-setup-runtime.ts";
import {
  ACCESS_SECRET,
  ENCRYPTION_KEY,
  applied,
  deploymentManifest,
} from "./persistence-test-fixtures.ts";
import { runtimeHarness } from "./runtime-test-harness.ts";

test("apply verifies both protected origins and persists credentials only after full verification", async () => {
  const context = runtimeHarness();
  await applySetupRuntime(
    { domain: "example.com", ownerEmail: "owner@example.com", showConnectionToken: true },
    context.dependencies,
  );

  expect(context.fetch.mock.calls.map((call) => String(call[0]))).toEqual([
    "https://shlook.example.com/health",
    "https://shlook.example.com/",
    "https://private.example.com/",
    "https://private.example.com/",
    "https://public.example.com/",
    "https://share.example.com/",
  ]);
  const authenticatedCalls = context.fetch.mock.calls.filter(
    (call) => call[1]?.headers !== undefined,
  );
  expect(authenticatedCalls).toHaveLength(2);
  for (const call of authenticatedCalls) {
    const headers = new Headers(call[1]?.headers);
    expect(headers.get("CF-Access-Client-Id")).toBe("access-client-id");
    expect(headers.get("CF-Access-Client-Secret")).toBe(ACCESS_SECRET);
  }
  expect(context.fetch.mock.calls.filter((call) => call[1]?.headers === undefined)).toHaveLength(4);
  const publicShareCalls = context.fetch.mock.calls.filter((call) =>
    ["https://public.example.com/", "https://share.example.com/"].includes(String(call[0])),
  );
  expect(publicShareCalls).toHaveLength(2);
  for (const call of publicShareCalls) {
    expect(call[1]?.headers).toBeUndefined();
    expect(JSON.stringify(call[1])).not.toContain("access-client-id");
    expect(JSON.stringify(call[1])).not.toContain(ACCESS_SECRET);
  }
  expect(context.events.slice(-7)).toEqual([
    "fetch:https://shlook.example.com/health",
    "fetch:https://shlook.example.com/",
    "fetch:https://private.example.com/",
    "fetch:https://private.example.com/",
    "fetch:https://public.example.com/",
    "fetch:https://share.example.com/",
    "persist",
  ]);
  expect(context.persistConnection).toHaveBeenCalledWith({
    domain: "example.com",
    accessClientId: "access-client-id",
    accessClientSecret: ACCESS_SECRET,
  });
});

test("apply passes matching stored credentials to Cloudflare and emits a token only by request", async () => {
  const applyCloudflareSetup = vi.fn(async (rawInput: unknown) => {
    const applyInput = rawInput as ApplySetupInput;
    await applyInput.persistence!.saveIntent(deploymentManifest);
    return {
      ...applied,
      resources: {
        ...applied.resources,
        accessServiceToken: { ...applied.resources.accessServiceToken, created: false },
      },
      createdServiceTokenCredentials: undefined,
    };
  });
  const context = runtimeHarness({
    applyCloudflareSetup,
    loadConnection: vi.fn(async () => ({
      domain: "example.com",
      accessClientId: "access-client-id",
      accessClientSecret: ACCESS_SECRET,
    })),
  });
  context.fileSystem.putFile(
    "/config/shlook/deployment/secret-encryption-key",
    `${ENCRYPTION_KEY}\n`,
  );
  const result = await applySetupRuntime(
    { domain: "example.com", ownerEmail: "owner@example.com", showConnectionToken: true },
    context.dependencies,
  );

  expect(applyCloudflareSetup.mock.calls[0][0]).toMatchObject({
    domain: "example.com",
    ownerEmail: "owner@example.com",
    existingServiceToken: {
      clientId: "access-client-id",
      clientSecret: ACCESS_SECRET,
    },
  });
  expect(result.connectionToken).toMatch(/^shlook_connect_v1_[A-Za-z0-9_-]+$/);
  expect(result.connectionToken).toContain("shlook_connect_v1_");
});

test("partial command or verification failure never persists a connection", async () => {
  const commandFailure = runtimeHarness({
    runCommand: vi.fn().mockResolvedValueOnce({ code: 0 }).mockResolvedValueOnce({ code: 17 }),
  });
  await expect(
    applySetupRuntime(
      { domain: "example.com", ownerEmail: "owner@example.com" },
      commandFailure.dependencies,
    ),
  ).rejects.toMatchObject({ code: "setup_command_failed" });
  expect(commandFailure.persistConnection).not.toHaveBeenCalled();
  expect(commandFailure.fetch).not.toHaveBeenCalled();
  expect(
    commandFailure.fileSystem.files.has("/config/shlook/deployment/pending-service-token.json"),
  ).toBe(true);

  const verificationFailure = runtimeHarness({
    fetch: vi.fn(async () => new Response(null, { status: 403 })),
  });
  let error: unknown;
  try {
    await applySetupRuntime(
      { domain: "example.com", ownerEmail: "owner@example.com" },
      verificationFailure.dependencies,
    );
  } catch (cause) {
    error = cause;
  }
  expect(error).toBeInstanceOf(SetupRuntimeError);
  expect(error).toMatchObject({ code: "setup_verification_failed" });
  expect(verificationFailure.dependencies.fetch).toHaveBeenCalledTimes(36);
  expect(verificationFailure.persistConnection).not.toHaveBeenCalled();
  expect(
    verificationFailure.fileSystem.files.has(
      "/config/shlook/deployment/pending-service-token.json",
    ),
  ).toBe(true);

  verificationFailure.dependencies.fetch.mockImplementation(
    async (url: string | URL | Request, init?: RequestInit) => {
      const target = new URL(String(url));
      const authenticated = new Headers(init?.headers).has("CF-Access-Client-Id");
      if (target.pathname === "/health") {
        return authenticated
          ? Response.json({ ok: true, service: "shlook" })
          : new Response(null, { status: 403 });
      }
      if (
        (target.origin === "https://shlook.example.com" ||
          target.origin === "https://private.example.com") &&
        !authenticated
      ) {
        return new Response(null, { status: 403 });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  );
  await applySetupRuntime(
    { domain: "example.com", ownerEmail: "owner@example.com" },
    verificationFailure.dependencies,
  );
  expect(
    verificationFailure.fileSystem.files.has(
      "/config/shlook/deployment/pending-service-token.json",
    ),
  ).toBe(false);
});

test("a persistence failure retains pending credentials and a rerun promotes them", async () => {
  let saved: { domain: string; accessClientId: string; accessClientSecret: string } | undefined;
  const persistConnection = vi
    .fn()
    .mockRejectedValueOnce(new Error(`${ACCESS_SECRET}: disk failure`))
    .mockImplementation(async (credential) => {
      saved = credential;
      return "/config/shlook/auth.json";
    });
  const loadConnection = vi.fn(async () => {
    if (saved === undefined) throw new Error("missing");
    return saved;
  });
  const context = runtimeHarness({ persistConnection, loadConnection });
  const first = applySetupRuntime(
    { domain: "example.com", ownerEmail: "owner@example.com" },
    context.dependencies,
  );
  const error = await first.catch((cause) => cause);
  expect(error).toMatchObject({ code: "connection_persistence_failed" });
  expect(String(error)).not.toContain(ACCESS_SECRET);
  const pendingPath = "/config/shlook/deployment/pending-service-token.json";
  expect(context.fileSystem.files.has(pendingPath)).toBe(true);

  await applySetupRuntime(
    { domain: "example.com", ownerEmail: "owner@example.com" },
    context.dependencies,
  );
  expect(context.fileSystem.files.has(pendingPath)).toBe(false);
  expect(persistConnection).toHaveBeenCalledTimes(2);
});

test("a connection for another domain is not supplied as an existing service token", async () => {
  const applyCloudflareSetup = vi.fn(async (_input: unknown, _dependencies: unknown) => {
    throw new SetupRuntimeError(
      "service_token_secret_unavailable",
      "the existing shlook Access service token secret cannot be recovered",
    );
  });
  const context = runtimeHarness({
    applyCloudflareSetup,
    loadConnection: vi.fn(async () => ({
      domain: "other.example.com",
      accessClientId: "wrong-id",
      accessClientSecret: "wrong-secret",
    })),
  });

  await expect(
    applySetupRuntime(
      { domain: "example.com", ownerEmail: "owner@example.com" },
      context.dependencies,
    ),
  ).rejects.toMatchObject({ code: "service_token_secret_unavailable" });
  expect(applyCloudflareSetup.mock.calls[0][0]).toMatchObject({
    domain: "example.com",
    ownerEmail: "owner@example.com",
  });
  expect(context.fileSystem.config()).toBe("");
  expect(context.runCommand).not.toHaveBeenCalled();
  expect(context.persistConnection).not.toHaveBeenCalled();
});
