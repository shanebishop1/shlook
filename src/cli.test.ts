// @vitest-environment node
import { expect, test, vi } from "vitest";

import { runCli, type CliDependencies } from "./cli";

const DEFAULT_ORIGIN = "https://show.shane-bishop.com";
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
    env: { CF_ACCESS_CLIENT_ID: "test-id", CF_ACCESS_CLIENT_SECRET: "test-secret" },
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
        else if (["--entrypoint", "--offset"].includes(value))
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
});

test("auth check sends Access headers without leaking credentials", async () => {
  const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    Response.json({ ok: true }),
  );
  const context = harness({
    fetch,
    env: {
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
    worker: "shlook",
    d1: "shlook",
    r2: "shlook-assets",
    hosts: ["show.shane-bishop.com", "private.show.shane-bishop.com", "share.shane-bishop.com"],
  });
  expect(output.data.access).toBeDefined();
  expect(output.data.inspection).toEqual({ inspected: ["package"], conflicts: [conflict] });
});

test("setup apply refuses conflicts and reports Access blocking as top-level failure", async () => {
  const runCommand = vi.fn(async () => ({ code: 0 }));
  const unresolved = harness({
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

  expect(await runCli(["setup", "--apply", "--json"], unresolved.dependencies)).toBe(2);
  expect(runCommand).not.toHaveBeenCalled();
  expect(unresolved.stdout).toEqual([]);
  expect(JSON.parse(unresolved.stderr[0])).toMatchObject({
    ok: false,
    command: "setup",
    error: { code: "setup_conflicts", details: { status: "blocked" } },
  });

  const context = harness({
    runCommand,
    inspectSetup: vi.fn(async () => ({ inspected: ["package", "remote"], conflicts: [] })),
  });

  expect(await runCli(["setup", "--apply", "--json"], context.dependencies)).toBe(2);
  expect(runCommand.mock.calls).toEqual([
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
        "/package/wrangler.jsonc",
      ],
      "/package",
    ],
    [
      "/node",
      [
        "/package/node_modules/wrangler/bin/wrangler.js",
        "deploy",
        "--config",
        "/package/wrangler.jsonc",
      ],
      "/package",
    ],
  ]);
  expect(context.stdout).toEqual([]);
  expect(JSON.parse(context.stderr[0])).toMatchObject({
    ok: false,
    command: "setup",
    error: {
      code: "access_configuration_required",
      details: { status: "blocked", completed: ["d1_migrations", "worker_deploy"] },
    },
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

  expect(await runCli(["publish", directory, "--json"], context.dependencies)).toBe(0);
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
  expect(await runCli(["publish", "/linked-artifact", "--json"], rejected.dependencies)).toBe(1);
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
  expect(await runCli(["publish", directory, "--json"], failed.dependencies)).toBe(1);
  expect(failedFetch.mock.calls[2][0]).toBe(`${DEFAULT_ORIGIN}/api/assets/${assetId}`);
  expect(failedFetch.mock.calls[2][1]?.method).toBe("DELETE");
  expect(JSON.parse(failed.stderr[0]).error).toMatchObject({
    code: "publish_failed",
    details: { assetId, cleanup: { attempted: true, succeeded: true } },
  });
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
      CF_ACCESS_CLIENT_ID: "test-id",
      CF_ACCESS_CLIENT_SECRET: "test-secret",
      SHLOOK_PRIVATE_ORIGIN: "https://private.test.example/",
    },
  });

  expect(await runCli(["verify", assetId, "--json"], context.dependencies)).toBe(0);
  expect(fetch.mock.calls[0][0]).toBe(`https://show.shane-bishop.com/api/assets/${assetId}`);
  expect(fetch.mock.calls[1][0]).toBe(`https://private.test.example/assets/${assetId}/`);
  expect(fetch.mock.calls[1][1]?.method).toBe("GET");
  expect(JSON.parse(context.stdout[0]).data).toEqual({ assetId, verified: true, status: 200 });
});

test("returns a failure exit code and stable sanitized JSON error", async () => {
  const context = harness({
    env: { CF_ACCESS_CLIENT_ID: "test-id", CF_ACCESS_CLIENT_SECRET: "must-not-leak" },
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
