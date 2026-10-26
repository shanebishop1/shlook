// @vitest-environment node
import { expect, test, vi } from "vitest";

import { runCli } from "../cli";
import { decodeConnectionCredential, encodeConnectionCredential } from "../cli-connection.ts";
import { setupRuntimeDependencies } from "./commands/setup.ts";
import { connectNamed } from "./connection.ts";
import { defaultOrigins } from "./origins.ts";
import type { ProfileConfig } from "./profiles.ts";
import { harness, storedCredential } from "./test-harness.ts";

test("setup parser passes flags over environment fallbacks to the Cloudflare plan", async () => {
  const planSetup = vi.fn(async (input) => ({ mode: "plan", ready: true, input }));
  const context = harness({
    env: {
      CLOUDFLARE_API_TOKEN: "bootstrap-secret",
      SHLOOK_DOMAIN: "environment.example.com",
      SHLOOK_OWNER_EMAIL: "environment@example.com",
      SHLOOK_ACCOUNT_ID: "e".repeat(32),
    },
    planSetup,
  });

  const exitCode = await runCli(
    [
      "setup",
      "--plan",
      "--domain",
      "flag.example.com",
      "--owner-email",
      "flag@example.com",
      "--account-id",
      "f".repeat(32),
      "--json",
    ],
    context.dependencies,
  );
  expect(exitCode, context.stderr.join("")).toBe(0);
  expect(planSetup).toHaveBeenCalledWith({
    domain: "flag.example.com",
    ownerEmail: "flag@example.com",
    accountId: "f".repeat(32),
  });
  expect(context.dependencies.runCommand).not.toHaveBeenCalled();

  const fallback = harness({
    env: context.dependencies.env,
    planSetup,
  });
  expect(await runCli(["setup", "--plan", "--json"], fallback.dependencies)).toBe(0);
  expect(planSetup).toHaveBeenLastCalledWith({
    domain: "environment.example.com",
    ownerEmail: "environment@example.com",
    accountId: "e".repeat(32),
  });
});

test("setup forwards the explicit dangerous adoption flag and never enables it implicitly", async () => {
  const planSetup = vi.fn(async (value) => ({ mode: "plan", value }));
  const environment = {
    CLOUDFLARE_API_TOKEN: "bootstrap-secret",
    SHLOOK_DOMAIN: "example.com",
    SHLOOK_OWNER_EMAIL: "owner@example.com",
  };
  const normal = harness({ env: environment, planSetup });
  expect(await runCli(["setup", "--plan", "--json"], normal.dependencies)).toBe(0);
  expect(planSetup.mock.calls[0][0]).not.toHaveProperty("adoptExisting");

  const dangerous = harness({ env: environment, planSetup });
  expect(
    await runCli(["setup", "--plan", "--adopt-existing", "--json"], dangerous.dependencies),
  ).toBe(0);
  expect(planSetup).toHaveBeenLastCalledWith({
    domain: "example.com",
    ownerEmail: "owner@example.com",
    adoptExisting: true,
  });
});

test("setup apply outputs a connection token only when explicitly requested", async () => {
  const token = encodeConnectionCredential(storedCredential);
  const applySetup = vi.fn(async (input) => ({
    mode: "apply",
    config: { path: "/config/shlook/deployment/wrangler.json" },
    connection: { stored: true, path: "/config/shlook/auth.json" },
    requestedTokenOutput: input.showConnectionToken,
    connectionToken: token,
  }));
  const environment = {
    CLOUDFLARE_API_TOKEN: "bootstrap-secret",
    SHLOOK_DOMAIN: "example.com",
    SHLOOK_OWNER_EMAIL: "owner@example.com",
  };

  const normal = harness({ env: environment, applySetup });
  expect(await runCli(["setup", "--apply", "--json"], normal.dependencies)).toBe(0);
  expect(normal.stdout.join("") + normal.stderr.join("")).not.toContain(token);
  expect(JSON.parse(normal.stdout[0]).data).not.toHaveProperty("connectionToken");

  const explicit = harness({ env: environment, applySetup });
  expect(
    await runCli(["setup", "--apply", "--show-connection-token", "--json"], explicit.dependencies),
  ).toBe(0);
  expect(JSON.parse(explicit.stdout[0]).data.connectionToken).toBe(token);

  const invalid = harness({ env: environment, planSetup: vi.fn() });
  expect(
    await runCli(["setup", "--plan", "--show-connection-token", "--json"], invalid.dependencies),
  ).toBe(1);
  expect(invalid.dependencies.planSetup).not.toHaveBeenCalled();
});

test("named setup rejects native profiles before any Cloudflare operation despite ambient credentials", async () => {
  const applySetup = vi.fn(async () => ({ mode: "apply" }));
  const context = harness({
    env: {
      CLOUDFLARE_API_TOKEN: "bootstrap-secret",
      CF_ACCESS_CLIENT_ID: "ambient-id",
      CF_ACCESS_CLIENT_SECRET: "ambient-secret",
      SHLOOK_DOMAIN: "example.com",
      SHLOOK_OWNER_EMAIL: "owner@example.com",
    },
    applySetup,
    loadProfileConfiguration: async () => ({
      version: 1,
      instances: { home: { type: "native", url: "https://home.example" } },
    }),
  });
  expect(
    await runCli(["setup", "--apply", "--instance", "home", "--json"], context.dependencies),
  ).toBe(1);
  expect(applySetup).not.toHaveBeenCalled();
  expect(context.dependencies.runCommand).not.toHaveBeenCalled();
  expect(JSON.parse(context.stderr[0]).error.code).toBe("unsupported_operation");
});

test("named setup plan never persists credentials or changes profile configuration", async () => {
  const planSetup = vi.fn(async () => ({ mode: "plan", ready: true }));
  const saveProfileCredential = vi.fn(async () => undefined);
  const saveProfileConfiguration = vi.fn(async () => undefined);
  const context = harness({
    env: {
      CLOUDFLARE_API_TOKEN: "bootstrap-secret",
      SHLOOK_DOMAIN: "example.com",
      SHLOOK_OWNER_EMAIL: "owner@example.com",
    },
    planSetup,
    saveProfileCredential,
    saveProfileConfiguration,
    loadProfileCredential: async () => undefined,
    loadProfileConfiguration: async () => ({ version: 1, instances: {} }),
  });
  expect(
    await runCli(["setup", "--plan", "--instance", "office", "--json"], context.dependencies),
  ).toBe(0);
  expect(planSetup).toHaveBeenCalledOnce();
  expect(saveProfileCredential).not.toHaveBeenCalled();
  expect(saveProfileConfiguration).not.toHaveBeenCalled();
});

test("named setup persistence binds and stores a Cloudflare credential without touching legacy auth", async () => {
  const config: ProfileConfig = { version: 1, instances: {} };
  const saveProfileCredential = vi.fn(
    async (_name: string, _type: "native" | "cloudflare", _url: string, _token: string) =>
      undefined,
  );
  const saveProfileConfiguration = vi.fn(async (next: ProfileConfig) => {
    Object.assign(config, next);
  });
  const persistConnection = vi.fn(async () => "/legacy/auth.json");
  const context = harness({
    env: {},
    saveProfileCredential,
    saveProfileConfiguration,
    loadProfileConfiguration: async () => config,
    persistConnection,
  });
  const runtime = setupRuntimeDependencies(context.dependencies, {
    name: "office",
    expected: defaultOrigins("example.com"),
  });
  const connection = {
    domain: "example.com",
    accessClientId: "named-id",
    accessClientSecret: "named-secret",
  };
  const path = await runtime.persistConnection(connection);
  const saved = saveProfileCredential.mock.calls[0];
  expect(saved?.slice(0, 3)).toEqual(["office", "cloudflare", "https://shlook.example.com"]);
  expect(decodeConnectionCredential(saved?.[3] ?? "")).toMatchObject({
    ...connection,
    origins: defaultOrigins("example.com"),
  });
  expect(config.instances.office).toEqual({
    type: "cloudflare",
    url: "https://shlook.example.com",
    origins: {
      private: "https://private.example.com",
      public: "https://public.example.com",
      share: "https://share.example.com",
    },
  });
  expect(path).toContain("credentials.json");
  expect(persistConnection).not.toHaveBeenCalled();
  expect(JSON.stringify(config)).not.toContain("named-secret");
});

test("named setup preserves a matching profile binding and rejects topology changes before planning", async () => {
  const origins = defaultOrigins("example.com");
  const existing: ProfileConfig = {
    version: 1,
    instances: {
      office: {
        type: "cloudflare",
        url: origins.owner,
        origins: { private: origins.private, public: origins.public, share: origins.share },
        token_env: "OFFICE_TOKEN",
      },
    },
  };
  const saveProfileConfiguration = vi.fn(async (next: ProfileConfig) => {
    Object.assign(existing, next);
  });
  const saveProfileCredential = vi.fn(
    async (_name: string, _type: "native" | "cloudflare", _url: string, _token: string) =>
      undefined,
  );
  const context = harness({
    env: {},
    saveProfileConfiguration,
    saveProfileCredential,
    loadProfileConfiguration: async () => existing,
  });
  const runtime = setupRuntimeDependencies(context.dependencies, {
    name: "office",
    profile: existing.instances.office as Extract<
      ProfileConfig["instances"][string],
      { type: "cloudflare" }
    >,
    expected: origins,
  });
  await runtime.persistConnection({
    domain: "example.com",
    accessClientId: "rotated-id",
    accessClientSecret: "rotated-secret",
  });
  expect(existing.instances.office?.token_env).toBe("OFFICE_TOKEN");

  const planSetup = vi.fn(async () => ({ mode: "plan" }));
  const mismatched = harness({
    env: { SHLOOK_DOMAIN: "elsewhere.com", SHLOOK_OWNER_EMAIL: "owner@example.com" },
    planSetup,
    loadProfileConfiguration: async () => existing,
  });
  expect(
    await runCli(["setup", "--plan", "--instance", "office", "--json"], mismatched.dependencies),
  ).toBe(1);
  expect(planSetup).not.toHaveBeenCalled();
});

test("named connect creates a normalized Cloudflare profile from the complete environment bundle", async () => {
  const origins = defaultOrigins("office.example.com");
  const token = encodeConnectionCredential({
    domain: "office.example.com",
    accessClientId: "office-id",
    accessClientSecret: "office-secret",
    origins,
  });
  const config: ProfileConfig = { version: 1, instances: {} };
  const saveProfileCredential = vi.fn(async () => undefined);
  const saveProfileConfiguration = vi.fn(async (next: ProfileConfig) => {
    Object.assign(config, next);
  });
  const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    expect(headers.get("CF-Access-Client-Id")).toBe("office-id");
    expect(headers.get("Authorization")).toBeNull();
    return Response.json({ ok: true, service: "shlook" });
  });
  const context = harness({
    env: { SHLOOK_API_TOKEN_OFFICE: token },
    fetch,
    saveProfileCredential,
    saveProfileConfiguration,
    loadProfileConfiguration: async () => config,
  });
  expect(await connectNamed(context.dependencies, "office", true)).toEqual({
    instance: "office",
    connected: true,
  });
  expect(saveProfileCredential.mock.calls[0]?.slice(0, 3)).toEqual([
    "office",
    "cloudflare",
    origins.owner,
  ]);
  expect(config.instances.office).toMatchObject({
    type: "cloudflare",
    url: origins.owner,
    origins: { private: origins.private, public: origins.public, share: origins.share },
  });
  expect(JSON.stringify({ result: context.stdout, config })).not.toContain("office-secret");
});

test("named connect rejects environment-name collisions before making a request", async () => {
  const origins = defaultOrigins("office.example.com");
  const token = encodeConnectionCredential({
    domain: "office.example.com",
    accessClientId: "id",
    accessClientSecret: "secret",
    origins,
  });
  const fetch = vi.fn(async () => Response.json({ ok: true, service: "shlook" }));
  const context = harness({
    env: { SHLOOK_API_TOKEN_OFFICE: token },
    fetch,
    loadProfileConfiguration: async () => ({
      version: 1,
      instances: {
        existing: {
          type: "native",
          url: "https://existing.example",
          token_env: "SHLOOK_API_TOKEN_OFFICE",
        },
      },
    }),
  });
  await expect(connectNamed(context.dependencies, "office", true)).rejects.toMatchObject({
    code: "invalid_configuration",
  });
  expect(fetch).not.toHaveBeenCalled();
});

test("named setup apply omits returned connection secrets from normal JSON output", async () => {
  const token = encodeConnectionCredential(storedCredential);
  const applySetup = vi.fn(async () => ({ mode: "apply", connectionToken: token }));
  const context = harness({
    env: { SHLOOK_DOMAIN: "example.com", SHLOOK_OWNER_EMAIL: "owner@example.com" },
    applySetup,
    loadProfileCredential: async () => undefined,
    loadProfileConfiguration: async () => ({ version: 1, instances: {} }),
  });
  expect(
    await runCli(["setup", "--apply", "--instance", "office", "--json"], context.dependencies),
  ).toBe(0);
  expect(JSON.parse(context.stdout[0]).data).not.toHaveProperty("connectionToken");
  expect(context.stdout.join("") + context.stderr.join("")).not.toContain(token);
});

test.each([
  ["empty environment credential", ""],
  ["native token supplied to Cloudflare setup", `shlook_api_v1_${"x".repeat(43)}`],
  ["malformed connection bundle", "shlook_connect_v1_%%%"],
])("named setup rejects %s before any Cloudflare operation", async (_label, token) => {
  const origins = defaultOrigins("example.com");
  const profile: ProfileConfig = {
    version: 1,
    instances: {
      office: {
        type: "cloudflare",
        url: origins.owner,
        origins: { private: origins.private, public: origins.public, share: origins.share },
        token_env: "OFFICE_TOKEN",
      },
    },
  };
  const applySetup = vi.fn(async () => ({ mode: "apply" }));
  const planSetup = vi.fn(async () => ({ mode: "plan" }));
  const loadProfileCredential = vi.fn(async () => {
    throw new Error("saved credential must not be consulted");
  });
  const saveProfileCredential = vi.fn(async () => undefined);
  const persistConnection = vi.fn(async () => "/legacy/auth.json");
  const context = harness({
    env: {
      SHLOOK_DOMAIN: "example.com",
      SHLOOK_OWNER_EMAIL: "owner@example.com",
      OFFICE_TOKEN: token,
    },
    applySetup,
    planSetup,
    loadProfileConfiguration: async () => profile,
    loadProfileCredential,
    saveProfileCredential,
    persistConnection,
  });
  expect(
    await runCli(["setup", "--apply", "--instance", "office", "--json"], context.dependencies),
  ).toBe(1);
  expect(JSON.parse(context.stderr[0]).error.code).toBe("invalid_credential");
  expect(loadProfileCredential).not.toHaveBeenCalled();
  expect(applySetup).not.toHaveBeenCalled();
  expect(planSetup).not.toHaveBeenCalled();
  expect(context.dependencies.fetch).not.toHaveBeenCalled();
  expect(context.dependencies.runCommand).not.toHaveBeenCalled();
  expect(saveProfileCredential).not.toHaveBeenCalled();
  expect(persistConnection).not.toHaveBeenCalled();
});

test("named setup rejects a present credential bound to a different topology before mutation", async () => {
  const origins = defaultOrigins("example.com");
  const wrongOrigins = defaultOrigins("other.example.com");
  const token = encodeConnectionCredential({
    domain: "example.com",
    accessClientId: "id",
    accessClientSecret: "secret",
    origins: wrongOrigins,
  });
  const applySetup = vi.fn(async () => ({ mode: "apply" }));
  const context = harness({
    env: {
      SHLOOK_DOMAIN: "example.com",
      SHLOOK_OWNER_EMAIL: "owner@example.com",
      OFFICE_TOKEN: token,
    },
    applySetup,
    loadProfileConfiguration: async () => ({
      version: 1,
      instances: {
        office: {
          type: "cloudflare",
          url: origins.owner,
          origins: { private: origins.private, public: origins.public, share: origins.share },
          token_env: "OFFICE_TOKEN",
        },
      },
    }),
  });
  expect(
    await runCli(["setup", "--apply", "--instance", "office", "--json"], context.dependencies),
  ).toBe(1);
  expect(JSON.parse(context.stderr[0]).error.code).toBe("invalid_credential");
  expect(applySetup).not.toHaveBeenCalled();
  expect(context.dependencies.fetch).not.toHaveBeenCalled();
  expect(context.dependencies.runCommand).not.toHaveBeenCalled();
});

test("named setup does not fall back to legacy auth when the selected profile has no credential", async () => {
  const origins = defaultOrigins("example.com");
  const applySetup = vi.fn(async () => ({ mode: "apply" }));
  const loadConnection = vi.fn(async () => storedCredential);
  const loadProfileCredential = vi.fn(async () => undefined);
  const context = harness({
    env: { SHLOOK_DOMAIN: "example.com", SHLOOK_OWNER_EMAIL: "owner@example.com" },
    applySetup,
    loadConnection,
    loadProfileCredential,
    loadProfileConfiguration: async () => ({
      version: 1,
      instances: {
        office: {
          type: "cloudflare",
          url: origins.owner,
          origins: { private: origins.private, public: origins.public, share: origins.share },
        },
      },
    }),
  });
  expect(
    await runCli(["setup", "--apply", "--instance", "office", "--json"], context.dependencies),
  ).toBe(1);
  expect(JSON.parse(context.stderr[0]).error.code).toBe("auth_required");
  expect(loadProfileCredential).toHaveBeenCalledOnce();
  expect(loadConnection).not.toHaveBeenCalled();
  expect(applySetup).not.toHaveBeenCalled();
  expect(context.dependencies.fetch).not.toHaveBeenCalled();
  expect(context.dependencies.runCommand).not.toHaveBeenCalled();
});

test.each(["corrupt saved credential", "saved credential topology mismatch"])(
  "named setup rejects %s before any Cloudflare operation",
  async (scenario) => {
    const origins = defaultOrigins("example.com");
    const mismatched = encodeConnectionCredential({
      domain: "example.com",
      accessClientId: "id",
      accessClientSecret: "secret",
      origins: defaultOrigins("elsewhere.example.com"),
    });
    const applySetup = vi.fn(async () => ({ mode: "apply" }));
    const loadProfileCredential =
      scenario === "corrupt saved credential"
        ? vi.fn(async () => {
            throw new Error("corrupt credentials file");
          })
        : vi.fn(async () => mismatched);
    const saveProfileCredential = vi.fn(async () => undefined);
    const persistConnection = vi.fn(async () => "/legacy/auth.json");
    const context = harness({
      env: { SHLOOK_DOMAIN: "example.com", SHLOOK_OWNER_EMAIL: "owner@example.com" },
      applySetup,
      loadProfileConfiguration: async () => ({
        version: 1,
        instances: {
          office: {
            type: "cloudflare",
            url: origins.owner,
            origins: { private: origins.private, public: origins.public, share: origins.share },
          },
        },
      }),
      loadProfileCredential,
      saveProfileCredential,
      persistConnection,
    });
    expect(
      await runCli(["setup", "--apply", "--instance", "office", "--json"], context.dependencies),
    ).toBe(1);
    expect(JSON.parse(context.stderr[0]).error.code).toBe("invalid_credential");
    expect(applySetup).not.toHaveBeenCalled();
    expect(context.dependencies.fetch).not.toHaveBeenCalled();
    expect(context.dependencies.runCommand).not.toHaveBeenCalled();
    expect(saveProfileCredential).not.toHaveBeenCalled();
    expect(persistConnection).not.toHaveBeenCalled();
  },
);

test("a new named setup can provision when its named credential is genuinely missing", async () => {
  const applySetup = vi.fn(async () => ({ mode: "apply", account: { id: "account" } }));
  const context = harness({
    env: { SHLOOK_DOMAIN: "example.com", SHLOOK_OWNER_EMAIL: "owner@example.com" },
    applySetup,
    loadProfileCredential: async () => undefined,
    loadProfileConfiguration: async () => ({ version: 1, instances: {} }),
  });
  expect(
    await runCli(["setup", "--apply", "--instance", "office", "--json"], context.dependencies),
  ).toBe(0);
  expect(applySetup).toHaveBeenCalledOnce();
});
