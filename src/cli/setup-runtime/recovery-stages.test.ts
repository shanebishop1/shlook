// @vitest-environment node
import { expect, test, vi } from "vitest";

import type { ApplySetupInput } from "../../cli-setup.ts";
import { SetupRuntimeError, applySetupRuntime } from "../../cli-setup-runtime.ts";
import { ENCRYPTION_KEY, applied, deploymentManifest } from "./persistence-test-fixtures.ts";
import { runtimeHarness } from "./runtime-test-harness.ts";

test.each([
  "apply result",
  "deployment secret",
  "configuration",
  "migrations",
  "deploy",
  "reconciliation",
  "verification",
  "connection persistence",
  "rotation cleanup",
  "pending cleanup",
] as const)("renewal reruns recover after failure during %s", async (stage) => {
  const rotatedSecret = "rotated-access-secret";
  let stored = {
    domain: "example.com",
    accessClientId: "access-client-id",
    accessClientSecret: "old-access-secret",
  };
  let persistFailed = false;
  const persistConnection = vi.fn(async (credential) => {
    if (stage === "connection persistence" && !persistFailed) {
      persistFailed = true;
      throw new Error("simulated persistence failure");
    }
    stored = credential;
    return "/config/shlook/auth.json";
  });
  let applyAttempt = 0;
  const applyCloudflareSetup = vi.fn(async (rawInput: unknown) => {
    const applyInput = rawInput as ApplySetupInput;
    applyAttempt += 1;
    await applyInput.persistence!.saveIntent(applyInput.deploymentManifest!);
    if (applyAttempt === 1) {
      await applyInput.persistence!.beginServiceTokenRotation(
        "service-token-id",
        "access-client-id",
      );
      await applyInput.persistence!.saveServiceToken({
        resourceId: "service-token-id",
        clientId: "access-client-id",
        clientSecret: rotatedSecret,
      });
      if (stage === "apply result") {
        throw new SetupRuntimeError("setup_command_failed", "simulated post-pending failure");
      }
    } else {
      expect(applyInput.existingServiceToken).toEqual({
        clientId: "access-client-id",
        clientSecret: rotatedSecret,
      });
    }
    return {
      ...applied,
      resources: {
        ...applied.resources,
        accessServiceToken: { ...applied.resources.accessServiceToken, created: false },
      },
      createdServiceTokenCredentials: undefined,
    };
  });
  let commandFailed = false;
  const runCommand = vi.fn(async (_command: string, args: string[]) => {
    const isMigration = args.includes("migrations");
    const shouldFail =
      !commandFailed &&
      ((stage === "migrations" && isMigration) || (stage === "deploy" && !isMigration));
    if (shouldFail) commandFailed = true;
    return { code: shouldFail ? 17 : 0 };
  });
  let reconcileFailed = false;
  const reconcileCloudflareSetup = vi.fn(async ({ deploymentManifest: value }) => {
    if (stage === "reconciliation" && !reconcileFailed) {
      reconcileFailed = true;
      throw new Error("simulated reconciliation failure");
    }
    return value;
  });
  let failedFetches = 0;
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (stage === "verification" && failedFetches < 36) {
      failedFetches += 1;
      return new Response(null, { status: 403 });
    }
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
  });
  const context = runtimeHarness({
    applyCloudflareSetup,
    fetch,
    loadConnection: vi.fn(async () => stored),
    persistConnection,
    reconcileCloudflareSetup,
    runCommand,
  });
  context.fileSystem.putFile(
    "/config/shlook/deployment/manifest.json",
    `${JSON.stringify(deploymentManifest, null, 2)}\n`,
  );
  context.fileSystem.putFile(
    "/config/shlook/deployment/secret-encryption-key",
    `${ENCRYPTION_KEY}\n`,
  );

  const originalOpen = context.fileSystem.fs.open;
  let secretFailed = false;
  context.fileSystem.fs.open = vi.fn(async (path, flags) => {
    if (stage === "deployment secret" && !secretFailed && path.endsWith("/secret-encryption-key")) {
      secretFailed = true;
      throw new Error("simulated secret read failure");
    }
    return originalOpen(path, flags);
  });

  const originalRename = context.fileSystem.fs.rename;
  let configurationFailed = false;
  context.fileSystem.fs.rename = vi.fn(async (from, to) => {
    if (stage === "configuration" && !configurationFailed && to.endsWith("/wrangler.json")) {
      configurationFailed = true;
      throw new Error("simulated configuration failure");
    }
    return originalRename(from, to);
  });
  const originalUnlink = context.fileSystem.fs.unlink;
  let cleanupFailed = false;
  context.fileSystem.fs.unlink = vi.fn(async (path) => {
    const selected =
      (stage === "rotation cleanup" && path.endsWith("/service-token-rotation.json")) ||
      (stage === "pending cleanup" && path.endsWith("/pending-service-token.json"));
    if (selected && !cleanupFailed) {
      cleanupFailed = true;
      throw new Error("simulated cleanup failure");
    }
    return originalUnlink(path);
  });

  await expect(
    applySetupRuntime(
      { domain: "example.com", ownerEmail: "owner@example.com" },
      context.dependencies,
    ),
  ).rejects.toBeDefined();
  await expect(
    applySetupRuntime(
      { domain: "example.com", ownerEmail: "owner@example.com" },
      context.dependencies,
    ),
  ).resolves.toMatchObject({ connection: { stored: true } });

  expect(stored).toEqual({
    domain: "example.com",
    accessClientId: "access-client-id",
    accessClientSecret: rotatedSecret,
  });
  expect(
    context.fileSystem.files.has("/config/shlook/deployment/service-token-rotation.json"),
  ).toBe(false);
  expect(context.fileSystem.files.has("/config/shlook/deployment/pending-service-token.json")).toBe(
    false,
  );
});
