// @vitest-environment node
import { Buffer } from "node:buffer";

import { expect, test, vi } from "vitest";

import type { ApplySetupInput, ApplySetupResult, SetupDeploymentManifest } from "./cli-setup.ts";
import {
  SetupRuntimeError,
  applySetupRuntime,
  loadOrCreateDeploymentSecret,
  planSetupRuntime,
  resolveSetupConfigPath,
  type SetupCommandOptions,
  type SetupRuntimeFileSystem,
} from "./cli-setup-runtime.ts";
import { isolatedCommandEnvironment } from "./cli.ts";

const ACCOUNT_ID = "a".repeat(32);
const ZONE_ID = "b".repeat(32);
const BOOTSTRAP_TOKEN = "bootstrap-token";
const ACCESS_SECRET = "access-secret";
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

const applied: ApplySetupResult = {
  mode: "apply",
  account: { id: ACCOUNT_ID, name: "Primary account" },
  zone: { id: ZONE_ID, name: "example.com" },
  origins: {
    owner: "https://shlook.example.com",
    private: "https://private.example.com",
    public: "https://public.example.com",
    share: "https://share.example.com",
  },
  resources: {
    d1: { id: "database-id", name: "shlook", created: true },
    r2: { id: "shlook-assets", name: "shlook-assets", created: true },
    accessApplications: {
      owner: {
        id: "owner-app-id",
        name: "shlook-owner",
        domain: "shlook.example.com",
        created: true,
      },
      private: {
        id: "private-app-id",
        name: "shlook-private",
        domain: "private.example.com",
        created: true,
      },
    },
    accessPolicies: {
      owner: {
        email: { id: "owner-email-policy", name: "shlook-owner-email", created: true },
        serviceToken: {
          id: "owner-token-policy",
          name: "shlook-service-token",
          created: true,
        },
      },
      private: {
        email: { id: "private-email-policy", name: "shlook-owner-email", created: true },
        serviceToken: {
          id: "private-token-policy",
          name: "shlook-service-token",
          created: true,
        },
      },
    },
    accessServiceToken: {
      id: "service-token-id",
      name: "shlook",
      clientId: "access-client-id",
      created: true,
    },
  },
  createdServiceTokenCredentials: {
    clientId: "access-client-id",
    clientSecret: ACCESS_SECRET,
  },
};

const deploymentManifest: SetupDeploymentManifest = {
  version: 1,
  domain: "example.com",
  ownerEmail: "owner@example.com",
  accountId: ACCOUNT_ID,
  zoneId: ZONE_ID,
  resources: {
    d1: { action: "create", name: "shlook", id: "database-id" },
    r2: { action: "create", name: "shlook-assets", id: "shlook-assets" },
    access_application_owner: { action: "create", name: "shlook-owner", id: "owner-app-id" },
    access_application_private: {
      action: "create",
      name: "shlook-private",
      id: "private-app-id",
    },
    access_service_token: { action: "create", name: "shlook", id: "service-token-id" },
    access_email_policy_owner: {
      action: "create",
      name: "shlook-owner-email",
      id: "owner-email-policy",
    },
    access_email_policy_private: {
      action: "create",
      name: "shlook-owner-email",
      id: "private-email-policy",
    },
    access_service_token_policy_owner: {
      action: "create",
      name: "shlook-service-token",
      id: "owner-token-policy",
    },
    access_service_token_policy_private: {
      action: "create",
      name: "shlook-service-token",
      id: "private-token-policy",
    },
    worker_service: { action: "create", name: "shlook", id: "shlook" },
    workers_domain_owner: {
      action: "create",
      name: "shlook.example.com",
      id: "owner-domain-id",
    },
    workers_domain_private: {
      action: "create",
      name: "private.example.com",
      id: "private-domain-id",
    },
    workers_domain_public: {
      action: "create",
      name: "public.example.com",
      id: "public-domain-id",
    },
    workers_domain_share: {
      action: "create",
      name: "share.example.com",
      id: "share-domain-id",
    },
  },
};

function fileSystemHarness() {
  const events: string[] = [];
  let config = "";
  const files = new Map<
    string,
    { data: string; mode: number; type: "file" | "fifo" | "symlink"; uid: number }
  >();
  const fs: SetupRuntimeFileSystem = {
    mkdir: vi.fn(async (path, options) => {
      events.push(`mkdir:${path}:${options.mode.toString(8)}`);
    }),
    chmod: vi.fn(async (path, mode) => {
      events.push(`chmod:${path}:${mode.toString(8)}`);
      const value = files.get(path);
      if (value !== undefined) value.mode = mode;
    }),
    writeFile: vi.fn(async (path, data, options) => {
      if (files.has(path)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      events.push(`write:${path}:${options.mode.toString(8)}:${options.flag}`);
      files.set(path, { data, mode: options.mode, type: "file", uid: process.getuid?.() ?? 0 });
      if (path.includes(".wrangler.json.")) config = data;
    }),
    rename: vi.fn(async (from, to) => {
      events.push(`rename:${from}:${to}`);
      const value = files.get(from);
      if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      files.set(to, value);
      files.delete(from);
    }),
    unlink: vi.fn(async (path) => {
      events.push(`unlink:${path}`);
      if (!files.delete(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }),
    link: vi.fn(async (from, to) => {
      events.push(`link:${from}:${to}`);
      if (files.has(to)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      const value = files.get(from);
      if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      files.set(to, value);
    }),
    open: vi.fn(async (path) => {
      events.push(`open:${path}`);
      const value = files.get(path);
      if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      if (value.type === "symlink") throw Object.assign(new Error("symlink"), { code: "ELOOP" });
      return {
        stat: vi.fn(async () => ({
          isFile: () => value.type === "file",
          mode: value.mode,
          size: Buffer.byteLength(value.data),
          uid: value.uid,
        })),
        readFile: vi.fn(async () => value.data),
        close: vi.fn(async () => undefined),
      };
    }),
  };
  return {
    fs,
    events,
    files,
    config: () => config,
    putFile: (
      path: string,
      data: string,
      mode = 0o600,
      type: "file" | "fifo" | "symlink" = "file",
    ) => files.set(path, { data, mode, type, uid: process.getuid?.() ?? 0 }),
  };
}

function runtimeHarness(overrides: Record<string, unknown> = {}) {
  const fileSystem = fileSystemHarness();
  const events: string[] = [];
  const deployedSecrets: string[] = [];
  const runCommand = vi.fn(
    async (_command: string, args: string[], _options: SetupCommandOptions) => {
      events.push("command");
      const index = args.indexOf("--secrets-file");
      if (index !== -1) {
        const data = fileSystem.files.get(args[index + 1])?.data;
        if (data !== undefined) deployedSecrets.push(data);
      }
      return { code: 0 };
    },
  );
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    events.push(`fetch:${String(input)}`);
    expect(init?.redirect).toBe("manual");
    return String(input).endsWith("/health")
      ? Response.json({ ok: true, service: "shlook" })
      : Response.json({ error: "not_found" }, { status: 404 });
  });
  let persistedCredential:
    | { domain: string; accessClientId: string; accessClientSecret: string }
    | undefined;
  const persistConnection = vi.fn(async (credential) => {
    events.push("persist");
    persistedCredential = credential;
    return "/config/shlook/auth.json";
  });
  const loadConnection = vi.fn(async () => {
    if (persistedCredential === undefined) throw new Error("missing");
    return persistedCredential;
  });
  const applyCloudflareSetup = vi.fn(async (rawInput: unknown) => {
    const applyInput = rawInput as ApplySetupInput;
    await applyInput.persistence?.saveIntent(applyInput.deploymentManifest ?? deploymentManifest);
    if (applyInput.existingServiceToken !== undefined) {
      return {
        ...applied,
        resources: {
          ...applied.resources,
          accessServiceToken: { ...applied.resources.accessServiceToken, created: false },
        },
        createdServiceTokenCredentials: undefined,
      };
    }
    await applyInput.persistence?.saveServiceToken({
      resourceId: "service-token-id",
      clientId: "access-client-id",
      clientSecret: ACCESS_SECRET,
    });
    return applied;
  });
  const dependencies = {
    env: {
      SHLOOK_CF_TOKEN: BOOTSTRAP_TOKEN,
      XDG_CONFIG_HOME: "/config",
      CF_ACCESS_CLIENT_ID: "must-not-reach-wrangler",
      CF_ACCESS_CLIENT_SECRET: "must-not-reach-wrangler",
      UNRELATED_SECRET: "must-not-reach-wrangler",
    },
    fetch,
    packageRoot: "/package",
    nodeExecutable: "/node",
    wranglerPath: "/package/node_modules/wrangler/bin/wrangler.js",
    runCommand,
    persistConnection,
    loadConnection,
    applyCloudflareSetup,
    reconcileCloudflareSetup: vi.fn(async ({ deploymentManifest: value }) => value),
    fs: fileSystem.fs,
    randomBytes: vi.fn(() => Buffer.alloc(32, 7)),
    randomId: vi.fn(() => "fixed-id"),
    sleep: vi.fn(async () => undefined),
    ...overrides,
  };
  return {
    dependencies,
    events,
    fileSystem,
    fetch,
    persistConnection,
    runCommand,
    deployedSecrets,
  };
}

test("resolves the setup config beneath a safe XDG or home config directory", () => {
  expect(resolveSetupConfigPath({ XDG_CONFIG_HOME: "/config" }, () => "/ignored")).toBe(
    "/config/shlook/deployment/wrangler.json",
  );
  expect(resolveSetupConfigPath({}, () => "/home/alice")).toBe(
    "/home/alice/.config/shlook/deployment/wrangler.json",
  );
  expect(() =>
    resolveSetupConfigPath({ XDG_CONFIG_HOME: "../escape" }, () => "/home/alice"),
  ).toThrow("invalid setup configuration path");
});

test("the command environment never inherits unrelated process credentials", () => {
  const previous = process.env.UNRELATED_SECRET;
  process.env.UNRELATED_SECRET = "inherited-secret";
  try {
    expect(
      isolatedCommandEnvironment({
        CLOUDFLARE_API_TOKEN: BOOTSTRAP_TOKEN,
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      }),
    ).toEqual({
      CLOUDFLARE_API_TOKEN: BOOTSTRAP_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    });
  } finally {
    if (previous === undefined) delete process.env.UNRELATED_SECRET;
    else process.env.UNRELATED_SECRET = previous;
  }
});

test("plan loads ownership state and delegates without local or command mutations", async () => {
  const plan = { ...applied, mode: "plan" as const, ready: true, actions: [], capabilities: {} };
  const planCloudflareSetup = vi.fn(async () => plan);
  const context = runtimeHarness({ planCloudflareSetup });

  await expect(
    planSetupRuntime(
      { domain: "example.com", ownerEmail: "owner@example.com", accountId: ACCOUNT_ID },
      context.dependencies,
    ),
  ).resolves.toBe(plan);
  expect(planCloudflareSetup).toHaveBeenCalledWith(
    { domain: "example.com", ownerEmail: "owner@example.com", accountId: ACCOUNT_ID },
    { env: context.dependencies.env, fetch: context.dependencies.fetch },
  );
  expect(context.runCommand).not.toHaveBeenCalled();
  expect(context.persistConnection).not.toHaveBeenCalled();
  expect(context.fileSystem.events).toEqual(["open:/config/shlook/deployment/manifest.json"]);
  expect(context.dependencies.randomBytes).not.toHaveBeenCalled();
});

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
    "write:/config/shlook/deployment/.wrangler.json.fixed-id:600:wx",
    `rename:/config/shlook/deployment/.wrangler.json.fixed-id:${configPath}`,
    `chmod:${configPath}:600`,
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

test("apply verifies both protected origins and persists credentials only after full verification", async () => {
  const context = runtimeHarness();
  await applySetupRuntime(
    { domain: "example.com", ownerEmail: "owner@example.com", showConnectionToken: true },
    context.dependencies,
  );

  expect(context.fetch.mock.calls.map((call) => String(call[0]))).toEqual([
    "https://shlook.example.com/health",
    "https://private.example.com/",
  ]);
  for (const call of context.fetch.mock.calls) {
    const headers = new Headers(call[1]?.headers);
    expect(headers.get("CF-Access-Client-Id")).toBe("access-client-id");
    expect(headers.get("CF-Access-Client-Secret")).toBe(ACCESS_SECRET);
  }
  expect(context.events.slice(-3)).toEqual([
    "fetch:https://shlook.example.com/health",
    "fetch:https://private.example.com/",
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
  expect(verificationFailure.dependencies.fetch).toHaveBeenCalledTimes(12);
  expect(verificationFailure.persistConnection).not.toHaveBeenCalled();
  expect(
    verificationFailure.fileSystem.files.has(
      "/config/shlook/deployment/pending-service-token.json",
    ),
  ).toBe(true);

  verificationFailure.dependencies.fetch.mockImplementation(async (url: string | URL | Request) =>
    String(url).endsWith("/health")
      ? Response.json({ ok: true })
      : Response.json({ error: "not_found" }, { status: 404 }),
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
