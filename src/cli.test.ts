// @vitest-environment node
import { expect, test, vi } from "vitest";

import { runCli, type CliDependencies } from "./cli";
import { encodeConnectionCredential, type ConnectionCredential } from "./cli-connection.ts";

const DEFAULT_ORIGIN = "https://shlook.example.com";
const DEFAULT_ENV = {
  CF_ACCESS_CLIENT_ID: "test-id",
  CF_ACCESS_CLIENT_SECRET: "test-secret",
  SHLOOK_DOMAIN: "example.com",
};
const assetId = "11111111-1111-4111-8111-111111111111";
const uploadId = "22222222-2222-4222-8222-222222222222";
const storedCredential: ConnectionCredential = {
  domain: "stored.example.com",
  accessClientId: "stored-client-id",
  accessClientSecret: "stored-client-secret",
};

function harness(overrides: Partial<CliDependencies> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const dependencies: CliDependencies = {
    cwd: "/repo",
    packageRoot: "/package",
    nodeExecutable: "/node",
    wranglerPath: "/package/node_modules/wrangler/bin/wrangler.js",
    env: DEFAULT_ENV,
    fetch: vi.fn(async () => Response.json({ ok: true })),
    runCommand: vi.fn(async () => ({ code: 0 })),
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    parseArguments: (argv) => {
      const positionals: string[] = [];
      const options: Record<string, boolean | string> = {};
      for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (["--json", "--plan", "--apply", "--show-connection-token"].includes(value))
          options[value === "--show-connection-token" ? "showConnectionToken" : value.slice(2)] =
            true;
        else if (
          [
            "--entrypoint",
            "--offset",
            "--name",
            "--description",
            "--domain",
            "--owner-email",
            "--account-id",
          ].includes(value)
        )
          options[
            value === "--owner-email"
              ? "ownerEmail"
              : value === "--account-id"
                ? "accountId"
                : value.slice(2)
          ] = argv[++index];
        else positionals.push(value);
      }
      return { positionals, options };
    },
    ...overrides,
  };
  return { dependencies, stdout, stderr };
}

test("emits the stable JSON envelope for status", async () => {
  const fetch = vi.fn(async () => Response.json({ ok: true, service: "shlook" }));
  const context = harness({ fetch });

  expect(await runCli(["--json", "status"], context.dependencies)).toBe(0);
  expect(JSON.parse(context.stdout.join(""))).toEqual({
    ok: true,
    command: "status",
    data: { ok: true, service: "shlook" },
  });
  expect(context.stderr).toEqual([]);

  const missing = harness({
    env: { CF_ACCESS_CLIENT_ID: "test-id", CF_ACCESS_CLIENT_SECRET: "test-secret" },
  });
  expect(await runCli(["status", "--json"], missing.dependencies)).toBe(1);
  expect(JSON.parse(missing.stderr[0]).error.code).toBe("configuration_required");

  const unsafePlan = harness({
    env: {
      ...DEFAULT_ENV,
      SHLOOK_API_ORIGIN: "https://user:password@owner.example.com",
    },
  });
  expect(await runCli(["setup", "--plan", "--json"], unsafePlan.dependencies)).toBe(1);
  expect(unsafePlan.stdout.join("") + unsafePlan.stderr.join("")).not.toContain("password");
});

test("auth check sends Access headers without leaking credentials", async () => {
  const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    Response.json({ ok: true }),
  );
  const context = harness({
    fetch,
    env: {
      ...DEFAULT_ENV,
      CF_ACCESS_CLIENT_ID: "client-id-value",
      CF_ACCESS_CLIENT_SECRET: "super-secret-value",
    },
  });

  expect(await runCli(["auth", "check", "--json"], context.dependencies)).toBe(0);
  const request = fetch.mock.calls[0][1];
  expect(new Headers(request?.headers).get("CF-Access-Client-Id")).toBe("client-id-value");
  expect(new Headers(request?.headers).get("CF-Access-Client-Secret")).toBe("super-secret-value");
  expect(context.stdout.join("") + context.stderr.join("")).not.toContain("super-secret-value");
});

test("connect verifies an injected token before persisting and emits only nonsecret fields", async () => {
  const token = encodeConnectionCredential(storedCredential);
  const readSecretInput = vi.fn(async () => token);
  const persistConnection = vi.fn(async () => "/config/shlook/auth.json");
  const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    Response.json({ ok: true }),
  );
  const context = harness({ env: {}, readSecretInput, persistConnection, fetch });

  expect(await runCli(["connect", "--json"], context.dependencies)).toBe(0);
  expect(readSecretInput).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][0]).toBe("https://shlook.stored.example.com/health");
  expect(fetch.mock.calls[0][1]?.redirect).toBe("manual");
  const headers = new Headers(fetch.mock.calls[0][1]?.headers);
  expect(headers.get("CF-Access-Client-Id")).toBe(storedCredential.accessClientId);
  expect(headers.get("CF-Access-Client-Secret")).toBe(storedCredential.accessClientSecret);
  expect(persistConnection).toHaveBeenCalledWith(storedCredential);
  expect(JSON.parse(context.stdout[0])).toEqual({
    ok: true,
    command: "connect",
    data: {
      domain: storedCredential.domain,
      path: "/config/shlook/auth.json",
      connected: true,
    },
  });
  const output = context.stdout.join("") + context.stderr.join("");
  expect(output).not.toContain(token);
  expect(output).not.toContain(storedCredential.accessClientId);
  expect(output).not.toContain(storedCredential.accessClientSecret);
});

test("connect never persists failed verification or leaks the injected secret", async () => {
  const token = encodeConnectionCredential(storedCredential);
  const persistConnection = vi.fn();
  const context = harness({
    env: {},
    readSecretInput: vi.fn(async () => token),
    persistConnection,
    fetch: vi.fn(async () => Response.json({ error: "denied" }, { status: 403 })),
  });

  expect(await runCli(["connect", "--json"], context.dependencies)).toBe(1);
  expect(persistConnection).not.toHaveBeenCalled();
  expect(JSON.parse(context.stderr[0]).error).toMatchObject({
    code: "connection_verification_failed",
    status: 403,
  });
  const output = context.stdout.join("") + context.stderr.join("");
  expect(output).not.toContain(token);
  expect(output).not.toContain(storedCredential.accessClientSecret);

  const argvAttempt = harness({
    env: {},
    readSecretInput: vi.fn(),
    persistConnection,
  });
  expect(await runCli(["connect", token, "--json"], argvAttempt.dependencies)).toBe(1);
  expect(argvAttempt.dependencies.readSecretInput).not.toHaveBeenCalled();
  expect(argvAttempt.stderr.join("")).not.toContain(token);
});

test("artifact commands automatically load a complete stored connection profile", async () => {
  const loadConnection = vi.fn(async () => storedCredential);
  const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    Response.json({ ok: true }),
  );
  const context = harness({ env: {}, loadConnection, fetch });

  expect(await runCli(["status", "--json"], context.dependencies)).toBe(0);
  expect(loadConnection).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][0]).toBe("https://shlook.stored.example.com/health");
  const headers = new Headers(fetch.mock.calls[0][1]?.headers);
  expect(headers.get("CF-Access-Client-Id")).toBe(storedCredential.accessClientId);
  expect(headers.get("CF-Access-Client-Secret")).toBe(storedCredential.accessClientSecret);
});

test("a complete environment profile wins over stored connection credentials", async () => {
  const loadConnection = vi.fn(async () => storedCredential);
  const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    Response.json({ ok: true }),
  );
  const context = harness({ loadConnection, fetch });

  expect(await runCli(["status", "--json"], context.dependencies)).toBe(0);
  expect(loadConnection).not.toHaveBeenCalled();
  expect(fetch.mock.calls[0][0]).toBe(DEFAULT_ORIGIN + "/health");
  const headers = new Headers(fetch.mock.calls[0][1]?.headers);
  expect(headers.get("CF-Access-Client-Id")).toBe(DEFAULT_ENV.CF_ACCESS_CLIENT_ID);
  expect(headers.get("CF-Access-Client-Secret")).toBe(DEFAULT_ENV.CF_ACCESS_CLIENT_SECRET);
});

test("a partial environment profile is rejected instead of mixing with stored credentials", async () => {
  const loadConnection = vi.fn(async () => storedCredential);
  const context = harness({
    env: {
      CF_ACCESS_CLIENT_ID: "environment-id",
      CF_ACCESS_CLIENT_SECRET: "environment-secret",
      SHLOOK_API_ORIGIN: "https://override.example.com",
    },
    loadConnection,
  });

  expect(await runCli(["status", "--json"], context.dependencies)).toBe(1);
  expect(loadConnection).not.toHaveBeenCalled();
  expect(context.dependencies.fetch).not.toHaveBeenCalled();
  expect(JSON.parse(context.stderr[0]).error.code).toBe("configuration_required");
});

test("a missing environment and stored profile returns a stable auth error", async () => {
  const loadConnection = vi.fn(async () => {
    throw new Error("filesystem details must not escape");
  });
  const context = harness({ env: {}, loadConnection });

  expect(await runCli(["status", "--json"], context.dependencies)).toBe(1);
  expect(JSON.parse(context.stderr[0]).error).toEqual({
    code: "auth_required",
    message: "a complete environment profile or stored connection is required",
  });
  expect(context.stderr.join("")).not.toContain("filesystem details");
});

test("accepts fully explicit legacy origins without a base domain", async () => {
  const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    Response.json({ ok: true }),
  );
  const context = harness({
    fetch,
    env: {
      CF_ACCESS_CLIENT_ID: "test-id",
      CF_ACCESS_CLIENT_SECRET: "test-secret",
      SHLOOK_API_ORIGIN: "https://owner.example.com",
      SHLOOK_PRIVATE_ORIGIN: "https://private.example.com",
      SHLOOK_PUBLIC_ORIGIN: "https://public.example.com",
      SHLOOK_SHARE_ORIGIN: "https://share.example.com",
    },
  });

  expect(await runCli(["status", "--json"], context.dependencies)).toBe(0);
  expect(fetch.mock.calls[0][0]).toBe("https://owner.example.com/health");
});

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

test("publish is private, rejects ancestor symlinks, and deletes failed creates", async () => {
  const directory = "/artifact";
  const loadPublishInput = vi.fn(async () => ({
    entrypoint: "index.html",
    files: [
      {
        path: "index.html",
        bytes: new TextEncoder().encode("<!doctype html><h1>safe</h1>"),
        contentType: "text/html; charset=utf-8",
      },
    ],
  }));
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/assets") && init?.method === "POST") {
      return Response.json({ asset: { id: assetId, visibility: "private" } }, { status: 201 });
    }
    if (init?.method === "PUT") {
      return Response.json({ file: { path: "index.html", uploadId } }, { status: 201 });
    }
    return Response.json({ asset: { id: assetId, visibility: "private", state: "live" } });
  });
  const context = harness({ fetch, loadPublishInput });

  expect(
    await runCli(
      [
        "publish",
        directory,
        "--name",
        "Release preview",
        "--description",
        "Owner archive refinement",
        "--json",
      ],
      context.dependencies,
    ),
  ).toBe(0);
  const create = fetch.mock.calls.find(([url]) => String(url).endsWith("/api/assets"));
  expect(JSON.parse(String(create?.[1]?.body))).toEqual({
    name: "Release preview",
    description: "Owner archive refinement",
  });
  const finalize = fetch.mock.calls.find(([url]) => String(url).endsWith("/finalize"));
  expect(JSON.parse(String(finalize?.[1]?.body))).toEqual({
    entrypoint: "index.html",
    files: [{ path: "index.html", uploadId }],
  });
  expect(JSON.parse(context.stdout[0]).data.asset.visibility).toBe("private");

  const rejected = harness({
    fetch,
    loadPublishInput: vi.fn(async () => {
      throw new Error("publish input or an ancestor is a symbolic link");
    }),
  });
  expect(
    await runCli(
      ["publish", "/linked-artifact", "--name", "Linked artifact", "--json"],
      rejected.dependencies,
    ),
  ).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(JSON.parse(rejected.stderr[0]).error.code).toBe("unsafe_publish_input");

  const failedFetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ asset: { id: assetId, visibility: "private" } }, { status: 201 }),
    )
    .mockResolvedValueOnce(Response.json({ error: "upload_failed" }, { status: 500 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const failed = harness({ fetch: failedFetch, loadPublishInput });
  expect(
    await runCli(["publish", directory, "--name", "Failed preview", "--json"], failed.dependencies),
  ).toBe(1);
  expect(failedFetch.mock.calls[2][0]).toBe(`${DEFAULT_ORIGIN}/api/assets/${assetId}`);
  expect(failedFetch.mock.calls[2][1]?.method).toBe("DELETE");
  expect(JSON.parse(failed.stderr[0]).error).toMatchObject({
    code: "publish_failed",
    details: { assetId, cleanup: { attempted: true, succeeded: true } },
  });
});

test("publish requires a bounded short name before reading files or calling the API", async () => {
  for (const argv of [
    ["publish", "/artifact", "--json"],
    ["publish", "/artifact", "--name", "   ", "--json"],
    ["publish", "/artifact", "--name", "x".repeat(81), "--json"],
  ]) {
    const context = harness({ loadPublishInput: vi.fn() });
    expect(await runCli(argv, context.dependencies)).toBe(1);
    expect(context.dependencies.loadPublishInput).not.toHaveBeenCalled();
    expect(context.dependencies.fetch).not.toHaveBeenCalled();
    expect(JSON.parse(context.stderr[0]).error.code).toBe("usage_error");
  }
});

test("maps visibility, secret, expiry, and delete commands to the owner API", async () => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return init?.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json({ secret: "one-time-secret" });
  });
  const commands = [
    ["visibility", assetId, "public"],
    ["secret", "create", assetId],
    ["secret", "rotate", assetId],
    ["secret", "revoke", assetId],
    ["share", "expiry", assetId, "2030-01-01T00:00:00Z"],
    ["hard", "expiry", assetId, "none"],
    ["delete", assetId],
  ];
  for (const command of commands) {
    expect(await runCli([...command, "--json"], harness({ fetch }).dependencies)).toBe(0);
  }

  expect(requests).toEqual([
    {
      url: `${DEFAULT_ORIGIN}/api/assets/${assetId}/visibility`,
      method: "PATCH",
      body: { visibility: "public" },
    },
    {
      url: `${DEFAULT_ORIGIN}/api/assets/${assetId}/secret?mode=create`,
      method: "POST",
      body: undefined,
    },
    {
      url: `${DEFAULT_ORIGIN}/api/assets/${assetId}/secret?mode=rotate`,
      method: "POST",
      body: undefined,
    },
    { url: `${DEFAULT_ORIGIN}/api/assets/${assetId}/secret`, method: "DELETE", body: undefined },
    {
      url: `${DEFAULT_ORIGIN}/api/assets/${assetId}/expiry`,
      method: "PATCH",
      body: { shareExpiresAt: "2030-01-01T00:00:00Z" },
    },
    {
      url: `${DEFAULT_ORIGIN}/api/assets/${assetId}/expiry`,
      method: "PATCH",
      body: { hardExpiresAt: null },
    },
    { url: `${DEFAULT_ORIGIN}/api/assets/${assetId}`, method: "DELETE", body: undefined },
  ]);
});

test("verify uses GET against the configured private origin", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ asset: { id: assetId, state: "live" } }))
    .mockResolvedValueOnce(new Response(null, { status: 200 }));
  const context = harness({
    fetch,
    env: {
      ...DEFAULT_ENV,
      CF_ACCESS_CLIENT_ID: "test-id",
      CF_ACCESS_CLIENT_SECRET: "test-secret",
      SHLOOK_PRIVATE_ORIGIN: "https://private.test.example/",
    },
  });

  expect(await runCli(["verify", assetId, "--json"], context.dependencies)).toBe(0);
  expect(fetch.mock.calls[0][0]).toBe(`${DEFAULT_ORIGIN}/api/assets/${assetId}`);
  expect(fetch.mock.calls[1][0]).toBe(`https://private.test.example/assets/${assetId}/`);
  expect(fetch.mock.calls[1][1]?.method).toBe("GET");
  expect(JSON.parse(context.stdout[0]).data).toEqual({ assetId, verified: true, status: 200 });
});

test("returns a failure exit code and stable sanitized JSON error", async () => {
  const context = harness({
    env: {
      ...DEFAULT_ENV,
      CF_ACCESS_CLIENT_ID: "test-id",
      CF_ACCESS_CLIENT_SECRET: "must-not-leak",
    },
    fetch: vi.fn(async () => Response.json({ error: "not_found" }, { status: 404 })),
  });

  expect(await runCli(["show", assetId, "--json"], context.dependencies)).toBe(1);
  expect(JSON.parse(context.stderr[0])).toEqual({
    ok: false,
    command: "show",
    error: { code: "api_error", message: "API request failed with status 404", status: 404 },
  });
  expect(context.stdout).toEqual([]);
  expect(context.stderr.join("")).not.toContain("must-not-leak");
});
