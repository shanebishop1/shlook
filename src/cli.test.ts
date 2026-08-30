// @vitest-environment node
import { expect, test, vi } from "vitest";

import { runCli, type CliDependencies } from "./cli";

const DEFAULT_ORIGIN = "https://owner.example.com";
const DEFAULT_ENV = {
  CF_ACCESS_CLIENT_ID: "test-id",
  CF_ACCESS_CLIENT_SECRET: "test-secret",
  SHLOOK_API_ORIGIN: DEFAULT_ORIGIN,
  SHLOOK_PRIVATE_ORIGIN: "https://private.example.com",
  SHLOOK_PUBLIC_ORIGIN: "https://public.example.com",
  SHLOOK_SHARE_ORIGIN: "https://share.example.com",
};
const assetId = "11111111-1111-4111-8111-111111111111";
const uploadId = "22222222-2222-4222-8222-222222222222";

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
        if (["--json", "--plan", "--apply"].includes(value)) options[value.slice(2)] = true;
        else if (["--entrypoint", "--offset", "--name", "--description"].includes(value))
          options[value.slice(2)] = argv[++index];
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

test("setup plan is read-only and reports unresolved inspection conflicts", async () => {
  const conflict = {
    code: "remote_state_uninspected",
    resource: "cloudflare",
    message: "remote resources were not inspected",
    unresolved: true,
  };
  const inspectSetup = vi.fn(async () => ({ inspected: ["package"], conflicts: [conflict] }));
  const context = harness({ inspectSetup });

  expect(await runCli(["setup", "--plan", "--json"], context.dependencies)).toBe(0);
  const output = JSON.parse(context.stdout[0]);
  expect(context.dependencies.fetch).not.toHaveBeenCalled();
  expect(context.dependencies.runCommand).not.toHaveBeenCalled();
  expect(inspectSetup).toHaveBeenCalledOnce();
  expect(output.data.resources).toMatchObject({
    workers: {
      customDomains: ["one Worker with four custom hostnames"],
      workersDev: ["shlook-owner", "shlook-private", "shlook-public", "shlook-share"],
    },
    bindings: { d1: "DB", r2: "ASSETS", encryptionKey: "SHLOOK_SECRET_ENCRYPTION_KEY" },
    names: "operator_owned",
    origins: {
      owner: "https://owner.example.com",
      private: "https://private.example.com",
      public: "https://public.example.com",
      share: "https://share.example.com",
    },
  });
  expect(output.data.ready).toBe(true);
  expect(output.data.access).toBeDefined();
  expect(output.data.inspection).toEqual({ inspected: ["package"], conflicts: [conflict] });

  const partial = harness({
    inspectSetup,
    env: { SHLOOK_API_ORIGIN: "https://owner.example.com" },
  });
  expect(await runCli(["setup", "--plan", "--json"], partial.dependencies)).toBe(0);
  expect(JSON.parse(partial.stdout[0]).data).toMatchObject({
    ready: false,
    resources: { origins: { owner: "https://owner.example.com" } },
  });
});

test("setup apply refuses mutation and points to the operator-owned setup plan", async () => {
  const runCommand = vi.fn(async () => ({ code: 0 }));
  const context = harness({
    runCommand,
    inspectSetup: vi.fn(async () => ({
      inspected: ["package"],
      conflicts: [
        {
          code: "remote_state_uninspected",
          resource: "cloudflare",
          message: "remote resources were not inspected",
          unresolved: true,
        },
      ],
    })),
  });

  expect(await runCli(["setup", "--apply", "--json"], context.dependencies)).toBe(2);
  expect(runCommand).not.toHaveBeenCalled();
  expect(context.stdout).toEqual([]);
  expect(JSON.parse(context.stderr[0])).toMatchObject({
    ok: false,
    command: "setup",
    error: { code: "setup_not_automated", details: { status: "blocked" } },
  });
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
  expect(fetch.mock.calls[0][0]).toBe(`https://owner.example.com/api/assets/${assetId}`);
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
