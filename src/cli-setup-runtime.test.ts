// @vitest-environment node
import { Buffer } from "node:buffer";

import { expect, test, vi } from "vitest";

import type { ApplySetupResult } from "./cli-setup.ts";
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
  const runCommand = vi.fn(
    async (_command: string, _args: string[], _options: SetupCommandOptions) => {
      events.push("command");
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
  const persistConnection = vi.fn(async () => {
    events.push("persist");
    return "/config/shlook/auth.json";
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
    applyCloudflareSetup: vi.fn(async (_input: unknown, _dependencies: unknown) => applied),
    fs: fileSystem.fs,
    randomBytes: vi.fn(() => Buffer.alloc(32, 7)),
    randomId: vi.fn(() => "fixed-id"),
    sleep: vi.fn(async () => undefined),
    ...overrides,
  };
  return { dependencies, events, fileSystem, fetch, persistConnection, runCommand };
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

test("plan delegates to read-only Cloudflare planning without local or command mutations", async () => {
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
  expect(context.fileSystem.events).toEqual([]);
  expect(context.dependencies.randomBytes).not.toHaveBeenCalled();
});

test("apply writes a strict secret-free config and securely runs migrations, deploy, and secret", async () => {
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
      ["/package/node_modules/wrangler/bin/wrangler.js", "deploy", "--config", configPath],
      { cwd: "/package", env: environment },
    ],
    [
      "/node",
      [
        "/package/node_modules/wrangler/bin/wrangler.js",
        "secret",
        "put",
        "SHLOOK_SECRET_ENCRYPTION_KEY",
        "--config",
        configPath,
      ],
      { cwd: "/package", env: environment, input: `${ENCRYPTION_KEY}\n` },
    ],
  ]);
  expect(context.runCommand.mock.calls.flatMap((call) => call[1])).not.toContain(ENCRYPTION_KEY);
  expect(JSON.stringify(result)).not.toContain(BOOTSTRAP_TOKEN);
  expect(JSON.stringify(result)).not.toContain(ACCESS_SECRET);
  expect(JSON.stringify(result)).not.toContain(ENCRYPTION_KEY);
  expect(result).toMatchObject({
    mode: "apply",
    config: { path: configPath },
    deployment: { migrationsApplied: true, deployed: true, secretStored: true },
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

  const secretInputs = context.runCommand.mock.calls
    .filter((call) => call[1].includes("SHLOOK_SECRET_ENCRYPTION_KEY"))
    .map((call) => call[2].input);
  expect(secretInputs).toEqual([`${first.toString("base64")}\n`, `${first.toString("base64")}\n`]);
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
  const secretAttempts = runCommand.mock.calls
    .filter((call) => call[1].includes("SHLOOK_SECRET_ENCRYPTION_KEY"))
    .map((call) => call[2].input);
  expect(secretAttempts).toEqual([
    `${first.toString("base64")}\n`,
    `${first.toString("base64")}\n`,
  ]);
  expect(randomBytes).toHaveBeenCalledOnce();
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
  expect(blockedApply.dependencies.applyCloudflareSetup).not.toHaveBeenCalled();
  expect(blockedApply.runCommand).not.toHaveBeenCalled();
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
  await expect(
    applySetupRuntime(
      { domain: "example.com", ownerEmail: "owner@example.com" },
      storedConnection.dependencies,
    ),
  ).rejects.toMatchObject({ code: "setup_secret_storage_failed" });
  expect(storedConnection.dependencies.randomBytes).not.toHaveBeenCalled();
  expect(storedConnection.dependencies.applyCloudflareSetup).not.toHaveBeenCalled();
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
  const applyCloudflareSetup = vi.fn(async (_input: unknown, _dependencies: unknown) => ({
    ...applied,
    resources: {
      ...applied.resources,
      accessServiceToken: { ...applied.resources.accessServiceToken, created: false },
    },
    createdServiceTokenCredentials: undefined,
  }));
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

  expect(applyCloudflareSetup.mock.calls[0][0]).toEqual({
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
  ).rejects.toMatchObject({ code: "setup_secret_storage_failed" });
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
  expect(applyCloudflareSetup.mock.calls[0][0]).toEqual({
    domain: "example.com",
    ownerEmail: "owner@example.com",
  });
  expect(context.fileSystem.config()).toBe("");
  expect(context.runCommand).not.toHaveBeenCalled();
  expect(context.persistConnection).not.toHaveBeenCalled();
});
