// @vitest-environment node
import { Buffer } from "node:buffer";

import { expect, test, vi } from "vitest";

import { applySetupRuntime } from "../../cli-setup-runtime.ts";
import {
  ACCESS_SECRET,
  ACCOUNT_ID,
  BOOTSTRAP_TOKEN,
  ENCRYPTION_KEY,
} from "./persistence-test-fixtures.ts";
import { runtimeHarness } from "./runtime-test-harness.ts";

test("apply writes a strict secret-free config and deploys routes with an owner-only secrets file", async () => {
  const context = runtimeHarness();
  const result = await applySetupRuntime(
    { domain: "example.com", ownerEmail: "owner@example.com", showConnectionToken: false },
    context.dependencies,
  );

  const configPath = "/config/shlook/deployment/wrangler.json";
  expect(
    context.fileSystem.events.filter(
      (event) =>
        event.includes("wrangler.json") &&
        !event.startsWith("unlink:") &&
        !event.startsWith("open:"),
    ),
  ).toEqual([
    `realpath:${configPath}`,
    "realpath:/config/shlook/deployment/.wrangler.json.fixed-id",
    "write:/config/shlook/deployment/.wrangler.json.fixed-id:600:wx",
    `realpath:${configPath}`,
    `rename:/config/shlook/deployment/.wrangler.json.fixed-id:${configPath}`,
    `realpath:${configPath}`,
    `fchmod:${configPath}:600`,
  ]);
  const config = JSON.parse(context.fileSystem.config());
  expect(config).toEqual({
    name: "shlook",
    main: "/package/src/index.ts",
    compatibility_date: "2026-08-26",
    account_id: ACCOUNT_ID,
    workers_dev: false,
    preview_urls: false,
    routes: [
      { pattern: "shlook.example.com", custom_domain: true },
      { pattern: "private.example.com", custom_domain: true },
      { pattern: "public.example.com", custom_domain: true },
      { pattern: "share.example.com", custom_domain: true },
    ],
    vars: {
      SHLOOK_OWNER_ORIGIN: "https://shlook.example.com",
      SHLOOK_PRIVATE_ORIGIN: "https://private.example.com",
      SHLOOK_PUBLIC_ORIGIN: "https://public.example.com",
      SHLOOK_SHARE_ORIGIN: "https://share.example.com",
      SHLOOK_OWNER_EMAIL: "owner@example.com",
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: "shlook",
        database_id: "database-id",
        migrations_dir: "/package/migrations",
      },
    ],
    r2_buckets: [{ binding: "ASSETS", bucket_name: "shlook-assets" }],
    triggers: { crons: ["*/5 * * * *"] },
  });
  expect(context.fileSystem.config()).not.toContain(BOOTSTRAP_TOKEN);
  expect(context.fileSystem.config()).not.toContain(ACCESS_SECRET);
  expect(context.fileSystem.config()).not.toContain(ENCRYPTION_KEY);
  expect(context.fileSystem.files.get("/config/shlook/deployment/manifest.json")).toMatchObject({
    mode: 0o600,
    type: "file",
  });
  expect(
    context.fileSystem.files.get("/config/shlook/deployment/manifest.json")?.data,
  ).not.toContain(ACCESS_SECRET);

  const environment = {
    CLOUDFLARE_API_TOKEN: BOOTSTRAP_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  };
  expect(context.runCommand.mock.calls).toEqual([
    [
      "/node",
      [
        "/package/node_modules/wrangler/bin/wrangler.js",
        "d1",
        "migrations",
        "apply",
        "shlook",
        "--remote",
        "--config",
        configPath,
      ],
      { cwd: "/package", env: environment },
    ],
    [
      "/node",
      [
        "/package/node_modules/wrangler/bin/wrangler.js",
        "deploy",
        "--strict",
        "--config",
        configPath,
        "--secrets-file",
        "/config/shlook/deployment/.deploy-secrets.fixed-id.json",
      ],
      { cwd: "/package", env: environment },
    ],
  ]);
  expect(context.runCommand.mock.calls.flatMap((call) => call[1])).not.toContain(ENCRYPTION_KEY);
  expect(context.deployedSecrets).toEqual([
    `${JSON.stringify({ SHLOOK_SECRET_ENCRYPTION_KEY: ENCRYPTION_KEY })}\n`,
  ]);
  expect(
    context.fileSystem.files.has("/config/shlook/deployment/.deploy-secrets.fixed-id.json"),
  ).toBe(false);
  expect(JSON.stringify(result)).not.toContain(BOOTSTRAP_TOKEN);
  expect(JSON.stringify(result)).not.toContain(ACCESS_SECRET);
  expect(JSON.stringify(result)).not.toContain(ENCRYPTION_KEY);
  expect(result).toMatchObject({
    mode: "apply",
    config: { path: configPath },
    deployment: { migrationsApplied: true, deployed: true, secretDeployed: true },
    verification: { ownerHealth: true, privateAccess: true },
    connection: { stored: true, path: "/config/shlook/auth.json" },
  });
  expect(result).not.toHaveProperty("connectionToken");
});

test("setup reruns reuse the exact persisted encryption key without generating another", async () => {
  const first = Buffer.alloc(32, 11);
  const second = Buffer.alloc(32, 12);
  const randomBytes = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
  const context = runtimeHarness({ randomBytes });

  await applySetupRuntime(
    { domain: "example.com", ownerEmail: "owner@example.com" },
    context.dependencies,
  );
  await applySetupRuntime(
    { domain: "example.com", ownerEmail: "owner@example.com" },
    context.dependencies,
  );

  expect(context.deployedSecrets).toEqual([
    `${JSON.stringify({ SHLOOK_SECRET_ENCRYPTION_KEY: first.toString("base64") })}\n`,
    `${JSON.stringify({ SHLOOK_SECRET_ENCRYPTION_KEY: first.toString("base64") })}\n`,
  ]);
  expect(randomBytes).toHaveBeenCalledOnce();
  expect(
    context.fileSystem.files.get("/config/shlook/deployment/secret-encryption-key"),
  ).toMatchObject({ data: `${first.toString("base64")}\n`, mode: 0o600, type: "file" });
});

test("a failed deployment persists its key for a safe retry instead of rotating", async () => {
  const first = Buffer.alloc(32, 13);
  const second = Buffer.alloc(32, 14);
  const randomBytes = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
  const runCommand = vi
    .fn()
    .mockResolvedValueOnce({ code: 0 })
    .mockResolvedValueOnce({ code: 19 })
    .mockResolvedValue({ code: 0 });
  const context = runtimeHarness({ randomBytes, runCommand });

  await expect(
    applySetupRuntime(
      { domain: "example.com", ownerEmail: "owner@example.com" },
      context.dependencies,
    ),
  ).rejects.toMatchObject({ code: "setup_command_failed" });
  expect(context.persistConnection).not.toHaveBeenCalled();

  await applySetupRuntime(
    { domain: "example.com", ownerEmail: "owner@example.com" },
    context.dependencies,
  );
  expect(context.deployedSecrets).toEqual([]);
  expect(randomBytes).toHaveBeenCalledOnce();
  expect(
    context.fileSystem.files.has("/config/shlook/deployment/.deploy-secrets.fixed-id.json"),
  ).toBe(false);
});

test("never runs a route-bearing deploy when the temporary secrets file cannot be created", async () => {
  const context = runtimeHarness();
  const originalWrite = context.fileSystem.fs.writeFile;
  context.fileSystem.fs.writeFile = vi.fn(async (path, data, options) => {
    if (path.includes(".deploy-secrets.")) throw new Error(`${ENCRYPTION_KEY}: disk full`);
    return originalWrite(path, data, options);
  });

  const operation = applySetupRuntime(
    { domain: "example.com", ownerEmail: "owner@example.com" },
    context.dependencies,
  );
  await expect(operation).rejects.toMatchObject({ code: "setup_secret_storage_failed" });
  expect(context.runCommand).toHaveBeenCalledTimes(1);
  expect(context.runCommand.mock.calls[0][1]).toContain("migrations");
  expect(context.runCommand.mock.calls.flatMap((call) => call[1])).not.toContain("deploy");
  expect(String(await operation.catch((error) => error))).not.toContain(ENCRYPTION_KEY);
});
