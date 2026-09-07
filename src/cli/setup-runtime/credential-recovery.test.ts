// @vitest-environment node
import { expect, test, vi } from "vitest";

import type { ApplySetupInput, SetupDeploymentManifest } from "../../cli-setup.ts";
import { SetupRuntimeError, applySetupRuntime } from "../../cli-setup-runtime.ts";
import {
  ACCESS_SECRET,
  ENCRYPTION_KEY,
  OTHER_ACCOUNT_ID,
  applied,
  deploymentManifest,
} from "./persistence-test-fixtures.ts";
import { runtimeHarness } from "./runtime-test-harness.ts";

test("a crash after one-time token creation resumes from owner-only pending credentials", async () => {
  const initialManifest: SetupDeploymentManifest = {
    ...deploymentManifest,
    resources: {
      ...deploymentManifest.resources,
      access_service_token: { action: "create", name: "shlook" },
    },
  };
  let attempt = 0;
  const applyCloudflareSetup = vi.fn(async (rawInput: unknown) => {
    const applyInput = rawInput as ApplySetupInput;
    attempt += 1;
    if (attempt === 1) {
      await applyInput.persistence!.saveIntent(initialManifest);
      await applyInput.persistence!.saveServiceToken({
        resourceId: "service-token-id",
        clientId: "access-client-id",
        clientSecret: ACCESS_SECRET,
      });
      throw new SetupRuntimeError("setup_command_failed", "simulated post-token failure");
    }
    expect(applyInput.existingServiceToken).toEqual({
      clientId: "access-client-id",
      clientSecret: ACCESS_SECRET,
    });
    expect(applyInput.deploymentManifest?.resources.access_service_token.id).toBe(
      "service-token-id",
    );
    await applyInput.persistence!.saveIntent(applyInput.deploymentManifest!);
    return {
      ...applied,
      resources: {
        ...applied.resources,
        accessServiceToken: { ...applied.resources.accessServiceToken, created: false },
      },
      createdServiceTokenCredentials: undefined,
    };
  });
  const context = runtimeHarness({ applyCloudflareSetup });

  const first = applySetupRuntime(
    { domain: "example.com", ownerEmail: "owner@example.com" },
    context.dependencies,
  );
  await expect(first).rejects.toMatchObject({ code: "setup_command_failed" });
  const pendingPath = "/config/shlook/deployment/pending-service-token.json";
  const manifestPath = "/config/shlook/deployment/manifest.json";
  expect(context.fileSystem.files.get(pendingPath)).toMatchObject({ mode: 0o600, type: "file" });
  expect(context.fileSystem.files.get(pendingPath)?.data).toContain(ACCESS_SECRET);
  expect(context.fileSystem.files.get(manifestPath)?.data).not.toContain(ACCESS_SECRET);
  expect(context.persistConnection).not.toHaveBeenCalled();

  const result = await applySetupRuntime(
    { domain: "example.com", ownerEmail: "owner@example.com" },
    context.dependencies,
  );
  expect(result.connection.stored).toBe(true);
  expect(context.fileSystem.files.has(pendingPath)).toBe(false);
  expect(context.fileSystem.files.get(manifestPath)?.data).not.toContain(ACCESS_SECRET);
  expect(JSON.stringify(result)).not.toContain(ACCESS_SECRET);
});

test("a renewal crash after pending persistence promotes the new credential on rerun", async () => {
  const rotatedSecret = "rotated-access-secret";
  let stored = {
    domain: "example.com",
    accessClientId: "access-client-id",
    accessClientSecret: "old-access-secret",
  };
  const loadConnection = vi.fn(async () => stored);
  const persistConnection = vi.fn(async (credential) => {
    stored = credential;
    return "/config/shlook/auth.json";
  });
  let attempt = 0;
  const applyCloudflareSetup = vi.fn(async (rawInput: unknown) => {
    const applyInput = rawInput as ApplySetupInput;
    attempt += 1;
    expect(applyInput.serviceTokenRotationPending).toBeUndefined();
    await applyInput.persistence!.saveIntent(applyInput.deploymentManifest!);
    if (attempt === 1) {
      expect(applyInput.serviceTokenRotationCompleted).toBeUndefined();
      expect(applyInput.existingServiceToken).toEqual({
        clientId: "access-client-id",
        clientSecret: "old-access-secret",
      });
      await applyInput.persistence!.beginServiceTokenRotation(
        "service-token-id",
        "access-client-id",
      );
      await applyInput.persistence!.saveServiceToken({
        resourceId: "service-token-id",
        clientId: "access-client-id",
        clientSecret: rotatedSecret,
      });
      throw new SetupRuntimeError("setup_command_failed", "simulated post-pending crash");
    }
    expect(applyInput.serviceTokenRotationCompleted).toBe(true);
    expect(applyInput.existingServiceToken).toEqual({
      clientId: "access-client-id",
      clientSecret: rotatedSecret,
    });
    return {
      ...applied,
      resources: {
        ...applied.resources,
        accessServiceToken: { ...applied.resources.accessServiceToken, created: false },
      },
      createdServiceTokenCredentials: {
        clientId: "access-client-id",
        clientSecret: rotatedSecret,
      },
    };
  });
  const context = runtimeHarness({
    applyCloudflareSetup,
    loadConnection,
    persistConnection,
  });
  context.fileSystem.putFile(
    "/config/shlook/deployment/manifest.json",
    `${JSON.stringify(deploymentManifest, null, 2)}\n`,
  );
  context.fileSystem.putFile(
    "/config/shlook/deployment/secret-encryption-key",
    `${ENCRYPTION_KEY}\n`,
  );

  await expect(
    applySetupRuntime(
      { domain: "example.com", ownerEmail: "owner@example.com" },
      context.dependencies,
    ),
  ).rejects.toMatchObject({ code: "setup_command_failed" });
  const recoveryPath = "/config/shlook/deployment/service-token-rotation.json";
  const pendingPath = "/config/shlook/deployment/pending-service-token.json";
  expect(context.fileSystem.files.has(recoveryPath)).toBe(true);
  expect(context.fileSystem.files.has(pendingPath)).toBe(true);
  expect(context.fileSystem.files.get(recoveryPath)?.data).not.toContain("old-access-secret");
  expect(context.persistConnection).not.toHaveBeenCalled();

  await applySetupRuntime(
    { domain: "example.com", ownerEmail: "owner@example.com" },
    context.dependencies,
  );
  expect(context.fileSystem.files.has(recoveryPath)).toBe(false);
  expect(context.fileSystem.files.has(pendingPath)).toBe(false);
  expect(stored.accessClientSecret).toBe(rotatedSecret);
  expect(applyCloudflareSetup).toHaveBeenCalledTimes(2);
});

test.each([
  "active domain",
  "active client ID",
  "active secret",
  "pending account",
  "pending zone",
  "pending resource",
  "pending client ID",
  "journal resource",
  "journal client ID",
  "manifest transition",
] as const)("renewal recovery rejects a mismatched %s", async (mismatch) => {
  let stored = {
    domain: "example.com",
    accessClientId: "access-client-id",
    accessClientSecret: "old-access-secret",
  };
  const applyCloudflareSetup = vi.fn(async (rawInput: unknown) => {
    const applyInput = rawInput as ApplySetupInput;
    await applyInput.persistence!.saveIntent(applyInput.deploymentManifest!);
    await applyInput.persistence!.beginServiceTokenRotation("service-token-id", "access-client-id");
    await applyInput.persistence!.saveServiceToken({
      resourceId: "service-token-id",
      clientId: "access-client-id",
      clientSecret: "rotated-access-secret",
    });
    throw new SetupRuntimeError("setup_command_failed", "simulated post-pending crash");
  });
  const context = runtimeHarness({
    applyCloudflareSetup,
    loadConnection: vi.fn(async () => stored),
  });
  const manifestPath = "/config/shlook/deployment/manifest.json";
  const pendingPath = "/config/shlook/deployment/pending-service-token.json";
  const rotationPath = "/config/shlook/deployment/service-token-rotation.json";
  context.fileSystem.putFile(manifestPath, `${JSON.stringify(deploymentManifest, null, 2)}\n`);
  context.fileSystem.putFile(
    "/config/shlook/deployment/secret-encryption-key",
    `${ENCRYPTION_KEY}\n`,
  );
  await expect(
    applySetupRuntime(
      { domain: "example.com", ownerEmail: "owner@example.com" },
      context.dependencies,
    ),
  ).rejects.toMatchObject({ code: "setup_command_failed" });

  const mutateFile = (path: string, field: string, value: string) => {
    const file = context.fileSystem.files.get(path);
    if (file === undefined) throw new Error(`missing test state ${path}`);
    file.data = `${JSON.stringify({ ...JSON.parse(file.data), [field]: value })}\n`;
  };
  if (mismatch === "active domain") stored = { ...stored, domain: "other.example.com" };
  if (mismatch === "active client ID") stored = { ...stored, accessClientId: "other-client-id" };
  if (mismatch === "active secret") stored = { ...stored, accessClientSecret: "other-secret" };
  if (mismatch === "pending account") mutateFile(pendingPath, "accountId", OTHER_ACCOUNT_ID);
  if (mismatch === "pending zone") mutateFile(pendingPath, "zoneId", "c".repeat(32));
  if (mismatch === "pending resource") mutateFile(pendingPath, "resourceId", "other-token-id");
  if (mismatch === "pending client ID") mutateFile(pendingPath, "clientId", "other-client-id");
  if (mismatch === "journal resource") mutateFile(rotationPath, "resourceId", "other-token-id");
  if (mismatch === "journal client ID") mutateFile(rotationPath, "clientId", "other-client-id");
  if (mismatch === "manifest transition") {
    const file = context.fileSystem.files.get(manifestPath)!;
    const manifest = JSON.parse(file.data) as SetupDeploymentManifest;
    manifest.resources.access_service_token.action = "adopt";
    file.data = `${JSON.stringify(manifest)}\n`;
  }

  await expect(
    applySetupRuntime(
      { domain: "example.com", ownerEmail: "owner@example.com" },
      context.dependencies,
    ),
  ).rejects.toMatchObject({ code: "setup_pending_credentials_failed" });
  expect(applyCloudflareSetup).toHaveBeenCalledOnce();
});
