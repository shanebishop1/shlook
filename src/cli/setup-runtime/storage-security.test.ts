// @vitest-environment node
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, vi } from "vitest";

import {
  applySetupRuntime,
  loadOrCreateDeploymentSecret,
  planSetupRuntime,
} from "../../cli-setup-runtime.ts";
import {
  ACCESS_SECRET,
  ACCOUNT_ID,
  BOOTSTRAP_TOKEN,
  ENCRYPTION_KEY,
  deploymentManifest,
} from "./persistence-test-fixtures.ts";
import { runtimeHarness } from "./runtime-test-harness.ts";

test("deployment secret loading rejects invalid, unsafe, and permissive files without rotation", async () => {
  const path = "/config/shlook/deployment/secret-encryption-key";
  for (const [data, mode, type] of [
    ["not-base64\n", 0o600, "file"],
    [`${ENCRYPTION_KEY}\n`, 0o644, "file"],
    [`${ENCRYPTION_KEY}\n`, 0o600, "fifo"],
    [`${ENCRYPTION_KEY}\n`, 0o600, "symlink"],
  ] as const) {
    const context = runtimeHarness();
    context.fileSystem.putFile(path, data, mode, type);

    await expect(loadOrCreateDeploymentSecret(context.dependencies)).rejects.toMatchObject({
      code: "setup_secret_storage_failed",
    });
    expect(context.dependencies.randomBytes).not.toHaveBeenCalled();
    expect(context.fileSystem.files.get(path)?.data).toBe(data);
  }

  const blockedApply = runtimeHarness();
  blockedApply.fileSystem.putFile(path, `${ENCRYPTION_KEY}\n`, 0o644);
  await expect(
    applySetupRuntime(
      { domain: "example.com", ownerEmail: "owner@example.com" },
      blockedApply.dependencies,
    ),
  ).rejects.toMatchObject({ code: "setup_secret_storage_failed" });
  expect(blockedApply.dependencies.applyCloudflareSetup).toHaveBeenCalledOnce();
  expect(blockedApply.runCommand).not.toHaveBeenCalled();
});

test("rejects mocked setup-state ancestor redirection before reading or writing", async () => {
  const context = runtimeHarness();
  vi.mocked(context.fileSystem.fs.realpath).mockResolvedValue(
    "/redirected/shlook/deployment/manifest.json",
  );

  await expect(
    planSetupRuntime(
      { domain: "example.com", ownerEmail: "owner@example.com", accountId: ACCOUNT_ID },
      context.dependencies,
    ),
  ).rejects.toMatchObject({ code: "setup_manifest_storage_failed" });
  expect(context.fileSystem.fs.open).not.toHaveBeenCalled();
  expect(context.fileSystem.fs.writeFile).not.toHaveBeenCalled();

  const secretContext = runtimeHarness();
  vi.mocked(secretContext.fileSystem.fs.realpath).mockResolvedValue(
    "/redirected/shlook/deployment",
  );
  await expect(loadOrCreateDeploymentSecret(secretContext.dependencies)).rejects.toMatchObject({
    code: "setup_secret_storage_failed",
  });
  expect(secretContext.fileSystem.fs.writeFile).not.toHaveBeenCalled();
  expect(secretContext.dependencies.randomBytes).not.toHaveBeenCalled();
});

test("rejects real symlinked setup-state directories without writing secrets through them", async () => {
  const root = await mkdtemp(join(tmpdir(), "shlook-setup-symlink-"));
  const redirected = join(root, "redirected");
  await mkdir(redirected);

  try {
    const xdg = join(root, "xdg");
    await mkdir(join(xdg, "shlook"), { recursive: true });
    await symlink(redirected, join(xdg, "shlook", "deployment"), "dir");
    const deploymentLink = runtimeHarness({ env: { XDG_CONFIG_HOME: xdg }, fs: undefined });
    await expect(loadOrCreateDeploymentSecret(deploymentLink.dependencies)).rejects.toMatchObject({
      code: "setup_secret_storage_failed",
      message: "unable to load or save the deployment encryption secret",
    });

    const ancestorTarget = join(root, "ancestor-target");
    const ancestorLink = join(root, "ancestor-link");
    await mkdir(ancestorTarget);
    await symlink(ancestorTarget, ancestorLink, "dir");
    const ancestor = runtimeHarness({
      env: { XDG_CONFIG_HOME: join(ancestorLink, "config") },
      fs: undefined,
    });
    await expect(loadOrCreateDeploymentSecret(ancestor.dependencies)).rejects.toMatchObject({
      code: "setup_secret_storage_failed",
    });

    await expect(
      writeFile(join(redirected, "secret-encryption-key"), "untouched", { flag: "wx" }),
    ).resolves.toBe(undefined);
    await expect(
      writeFile(
        join(ancestorTarget, "config", "shlook", "deployment", "secret-encryption-key"),
        "untouched",
        { flag: "wx" },
      ),
    ).resolves.toBe(undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects permissive or malformed ownership manifests before Cloudflare mutation", async () => {
  for (const [data, mode] of [
    [`${JSON.stringify(deploymentManifest)}\n`, 0o644],
    ["{malformed", 0o600],
  ] as const) {
    const context = runtimeHarness();
    context.fileSystem.putFile("/config/shlook/deployment/manifest.json", data, mode);
    await expect(
      applySetupRuntime(
        { domain: "example.com", ownerEmail: "owner@example.com" },
        context.dependencies,
      ),
    ).rejects.toMatchObject({ code: "setup_manifest_storage_failed" });
    expect(context.dependencies.applyCloudflareSetup).not.toHaveBeenCalled();
    expect(context.runCommand).not.toHaveBeenCalled();
  }
});

test("a rerun with missing deployment-secret state fails closed instead of rotating", async () => {
  const secretPath = "/config/shlook/deployment/secret-encryption-key";
  const configPath = "/config/shlook/deployment/wrangler.json";
  const missingBesideConfig = runtimeHarness();
  missingBesideConfig.fileSystem.putFile(configPath, "{}\n");

  await expect(
    loadOrCreateDeploymentSecret(missingBesideConfig.dependencies),
  ).rejects.toMatchObject({ code: "setup_secret_storage_failed" });
  expect(missingBesideConfig.dependencies.randomBytes).not.toHaveBeenCalled();
  expect(missingBesideConfig.fileSystem.files.has(secretPath)).toBe(false);

  const storedConnection = runtimeHarness({
    loadConnection: vi.fn(async () => ({
      domain: "example.com",
      accessClientId: "existing-id",
      accessClientSecret: "existing-secret",
    })),
  });
  storedConnection.fileSystem.putFile(
    "/config/shlook/deployment/manifest.json",
    `${JSON.stringify(deploymentManifest, null, 2)}\n`,
  );
  await expect(
    applySetupRuntime(
      { domain: "example.com", ownerEmail: "owner@example.com" },
      storedConnection.dependencies,
    ),
  ).rejects.toMatchObject({ code: "setup_secret_storage_failed" });
  expect(storedConnection.dependencies.randomBytes).not.toHaveBeenCalled();
  expect(storedConnection.dependencies.applyCloudflareSetup).toHaveBeenCalledOnce();
});

test("setup failures are stable and never reflect command or encryption secrets", async () => {
  const commandFailure = runtimeHarness({
    runCommand: vi.fn(async () => {
      throw new Error(`${BOOTSTRAP_TOKEN}:${ACCESS_SECRET}:${ENCRYPTION_KEY}`);
    }),
  });
  let commandError: unknown;
  try {
    await applySetupRuntime(
      { domain: "example.com", ownerEmail: "owner@example.com" },
      commandFailure.dependencies,
    );
  } catch (cause) {
    commandError = cause;
  }
  expect(commandError).toMatchObject({
    code: "setup_command_failed",
    message: "setup failed while applying database migrations",
  });
  expect(String(commandError)).not.toContain(BOOTSTRAP_TOKEN);
  expect(String(commandError)).not.toContain(ACCESS_SECRET);
  expect(String(commandError)).not.toContain(ENCRYPTION_KEY);

  const randomFailure = runtimeHarness({ randomBytes: vi.fn(() => new Uint8Array(31)) });
  await expect(
    applySetupRuntime(
      { domain: "example.com", ownerEmail: "owner@example.com" },
      randomFailure.dependencies,
    ),
  ).rejects.toMatchObject({ code: "setup_secret_generation_failed" });
  expect(randomFailure.persistConnection).not.toHaveBeenCalled();

  const pathFailure = runtimeHarness({
    env: { SHLOOK_CF_TOKEN: BOOTSTRAP_TOKEN, XDG_CONFIG_HOME: "../unsafe" },
  });
  await expect(
    applySetupRuntime(
      { domain: "example.com", ownerEmail: "owner@example.com" },
      pathFailure.dependencies,
    ),
  ).rejects.toMatchObject({ code: "setup_manifest_storage_failed" });
  expect(pathFailure.runCommand).not.toHaveBeenCalled();
  expect(pathFailure.persistConnection).not.toHaveBeenCalled();
});
