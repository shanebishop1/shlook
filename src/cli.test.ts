// @vitest-environment node
import { EventEmitter } from "node:events";

import { expect, test, vi } from "vitest";

import { readConnectionToken, runCli, type CliDependencies } from "./cli";
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

class SecretInput extends EventEmitter {
  readonly rawModes: boolean[] = [];
  readonly resume = vi.fn(() => {
    this.paused = false;
  });
  readonly pause = vi.fn(() => {
    this.paused = true;
  });
  isRaw: boolean;

  constructor(
    readonly isTTY: boolean,
    private paused: boolean,
    initiallyRaw = false,
  ) {
    super();
    this.isRaw = initiallyRaw;
  }

  isPaused(): boolean {
    return this.paused;
  }

  setRawMode(mode: boolean): void {
    this.rawModes.push(mode);
    this.isRaw = mode;
  }
}

function secretOutput() {
  const chunks: string[] = [];
  return { chunks, stream: { write: (value: string) => chunks.push(value) } };
}

function expectTerminalRestored(input: SecretInput, initiallyRaw = false): void {
  expect(input.isRaw).toBe(initiallyRaw);
  expect(input.isPaused()).toBe(true);
  expect(input.eventNames()).toEqual([]);
}

test("reads a hidden TTY connection token through Enter and restores the terminal", async () => {
  const input = new SecretInput(true, true);
  const output = secretOutput();
  const reading = readConnectionToken(input, output.stream);

  input.emit("data", Buffer.from("pasted-secret\r\n"));

  await expect(reading).resolves.toBe("pasted-secret");
  expect(output.chunks.join("")).toBe("Connection token: \n");
  expect(output.chunks.join("")).not.toContain("pasted-secret");
  expect(input.rawModes).toEqual([true, false]);
  expect(input.resume).toHaveBeenCalledOnce();
  expect(input.pause).toHaveBeenCalledOnce();
  expectTerminalRestored(input);
});

test("handles TTY backspace without echoing input and preserves an existing raw/flowing state", async () => {
  const input = new SecretInput(true, false, true);
  const output = secretOutput();
  const reading = readConnectionToken(input, output.stream);

  input.emit("data", "pasted-XY\u007f\btoken\n");

  await expect(reading).resolves.toBe("pasted-token");
  expect(output.chunks.join("")).not.toContain("pasted-");
  expect(input.rawModes).toEqual([true, true]);
  expect(input.pause).not.toHaveBeenCalled();
  expect(input.isRaw).toBe(true);
  expect(input.isPaused()).toBe(false);
  expect(input.eventNames()).toEqual([]);
});

test("rejects empty TTY input and restores terminal state", async () => {
  const input = new SecretInput(true, true);
  const output = secretOutput();
  const reading = readConnectionToken(input, output.stream);

  input.emit("data", "\r");

  await expect(reading).rejects.toThrow("connection credential input is required");
  expect(output.chunks.join("")).toBe("Connection token: \n");
  expectTerminalRestored(input);
});

test("cancels TTY input on Ctrl-C without leaking or leaving terminal state changed", async () => {
  const input = new SecretInput(true, true);
  const output = secretOutput();
  const reading = readConnectionToken(input, output.stream);

  input.emit("data", "do-not-print\u0003");

  await expect(reading).rejects.toThrow("connection credential input cancelled");
  expect(output.chunks.join("")).toBe("Connection token: \n");
  expect(output.chunks.join("")).not.toContain("do-not-print");
  expectTerminalRestored(input);
});

test("bounds TTY input at 20KB and restores terminal state", async () => {
  const input = new SecretInput(true, true);
  const output = secretOutput();
  const reading = readConnectionToken(input, output.stream);

  input.emit("data", "x".repeat(20_001));

  await expect(reading).rejects.toThrow("connection credential input is invalid");
  expect(output.chunks.join("")).not.toContain("xxx");
  expectTerminalRestored(input);
});

test("restores TTY state after a stream error without disclosing buffered input", async () => {
  const input = new SecretInput(true, true);
  const output = secretOutput();
  const reading = readConnectionToken(input, output.stream);

  input.emit("data", "buffered-secret");
  input.emit("error", new Error("terminal failed"));

  await expect(reading).rejects.toThrow("terminal failed");
  expect(output.chunks.join("")).not.toContain("buffered-secret");
  expectTerminalRestored(input);
});

test("continues reading piped connection tokens without prompting", async () => {
  const input = new SecretInput(false, true);
  const output = secretOutput();
  const reading = readConnectionToken(input, output.stream);

  input.emit("data", Buffer.from("  piped-token\r\n"));
  input.emit("end");

  await expect(reading).resolves.toBe("piped-token");
  expect(output.chunks).toEqual([]);
  expect(input.rawModes).toEqual([]);
  expectTerminalRestored(input);
});

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
    currentUid: () => 1_000,
    parseArguments: (argv) => {
      const positionals: string[] = [];
      const options: Record<string, boolean | string> = {};
      for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (
          ["--json", "--plan", "--apply", "--show-connection-token", "--adopt-existing"].includes(
            value,
          )
        )
          options[
            value === "--show-connection-token"
              ? "showConnectionToken"
              : value === "--adopt-existing"
                ? "adoptExisting"
                : value.slice(2)
          ] = true;
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

function simulatedRedirectFetch(
  respond: (input: string | URL | Request, init?: RequestInit) => Promise<Response> | Response,
) {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const implementation = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    const response = await respond(input, init);
    const location = response.headers.get("location");
    if (
      response.status >= 300 &&
      response.status < 400 &&
      init?.redirect !== "manual" &&
      location
    ) {
      return implementation(location, init);
    }
    return response;
  };
  return { fetch: vi.fn(implementation), requests };
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
  expect(request?.redirect).toBe("manual");
  expect(new Headers(request?.headers).get("CF-Access-Client-Id")).toBe("client-id-value");
  expect(new Headers(request?.headers).get("CF-Access-Client-Secret")).toBe("super-secret-value");
  expect(context.stdout.join("") + context.stderr.join("")).not.toContain("super-secret-value");
});

test("connect verifies an injected token before persisting and emits only nonsecret fields", async () => {
  const token = encodeConnectionCredential(storedCredential);
  const readSecretInput = vi.fn(async () => token);
  const persistConnection = vi.fn(async () => "/config/shlook/auth.json");
  const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    Response.json({ ok: true, service: "shlook" }),
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

test("connect rejects nonexact, empty, oversized, and invalid UTF-8 health bodies without persisting", async () => {
  const token = encodeConnectionCredential(storedCredential);
  const secretBody = "health-body-secret-must-not-leak";
  const responses = [
    Response.json({ ok: true }),
    Response.json({ ok: true, service: "other" }),
    Response.json({ ok: true, service: "shlook", extra: secretBody }),
    new Response(null, { status: 204 }),
    new Response("{not-json", { headers: { "content-type": "application/json" } }),
    new Response(`${JSON.stringify({ ok: true, service: "shlook" })}${"x".repeat(65_536)}`, {
      headers: { "content-type": "application/json" },
    }),
    new Response(Uint8Array.of(0xff), {
      headers: { "content-type": "application/json" },
    }),
  ];

  for (const response of responses) {
    const persistConnection = vi.fn();
    const context = harness({
      env: {},
      readSecretInput: vi.fn(async () => token),
      persistConnection,
      fetch: vi.fn(async () => response),
    });

    expect(await runCli(["connect", "--json"], context.dependencies)).toBe(1);
    expect(persistConnection).not.toHaveBeenCalled();
    expect(JSON.parse(context.stderr[0]).error).toEqual({
      code: "connection_verification_failed",
      message: "connection verification failed",
    });
    const output = context.stdout.join("") + context.stderr.join("");
    expect(output).not.toContain(secretBody);
    expect(output).not.toContain(storedCredential.accessClientSecret);
  }
});

test("connect fails safely before credential handling when secure local storage is unsupported", async () => {
  const readSecretInput = vi.fn(async () => encodeConnectionCredential(storedCredential));
  const fetch = vi.fn(async () => Response.json({ ok: true, service: "shlook" }));
  const persistConnection = vi.fn(async () => "/config/shlook/auth.json");
  const context = harness({
    env: {},
    currentUid: () => undefined,
    readSecretInput,
    fetch,
    persistConnection,
  });

  expect(await runCli(["connect", "--json"], context.dependencies)).toBe(1);
  expect(readSecretInput).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(persistConnection).not.toHaveBeenCalled();
  expect(JSON.parse(context.stderr[0]).error).toEqual({
    code: "connection_persistence_failed",
    message: "local connection credential storage is unavailable",
  });
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
  expect(fetch.mock.calls.every(([, init]) => init?.redirect === "manual")).toBe(true);
  expect(JSON.parse(String(create?.[1]?.body))).toEqual({
    name: "Release preview",
    description: "Owner archive refinement",
  });
  const finalize = fetch.mock.calls.find(([url]) => String(url).endsWith("/finalize"));
  const upload = fetch.mock.calls.find(([, init]) => init?.method === "PUT");
  expect(new Headers(upload?.[1]?.headers).get("content-length")).toBe(
    String(new TextEncoder().encode("<!doctype html><h1>safe</h1>").byteLength),
  );
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
  expect(fetch.mock.calls.every(([, init]) => init?.redirect === "manual")).toBe(true);
  expect(JSON.parse(context.stdout[0]).data).toEqual({ assetId, verified: true, status: 200 });
});

test("Access-authenticated requests reject redirects without forwarding credentials", async () => {
  const redirect = () =>
    new Response(null, {
      status: 302,
      headers: { location: "https://attacker.invalid/capture" },
    });

  const apiProbe = simulatedRedirectFetch((input) =>
    String(input).startsWith("https://attacker.invalid/")
      ? Response.json({ ok: true })
      : redirect(),
  );
  const apiContext = harness({ fetch: apiProbe.fetch });
  expect(await runCli(["status", "--json"], apiContext.dependencies)).toBe(1);
  expect(JSON.parse(apiContext.stderr[0]).error).toMatchObject({ code: "api_error", status: 302 });
  expect(apiProbe.requests.map(({ url }) => url)).toEqual([`${DEFAULT_ORIGIN}/health`]);

  const connectProbe = simulatedRedirectFetch((input) =>
    String(input).startsWith("https://attacker.invalid/")
      ? Response.json({ ok: true })
      : redirect(),
  );
  const connectContext = harness({
    env: {},
    fetch: connectProbe.fetch,
    readSecretInput: vi.fn(async () => encodeConnectionCredential(storedCredential)),
    persistConnection: vi.fn(),
  });
  expect(await runCli(["connect", "--json"], connectContext.dependencies)).toBe(1);
  expect(JSON.parse(connectContext.stderr[0]).error).toMatchObject({
    code: "connection_verification_failed",
    status: 302,
  });
  expect(connectProbe.requests.map(({ url }) => url)).toEqual([
    "https://shlook.stored.example.com/health",
  ]);

  const publishProbe = simulatedRedirectFetch((input, init) => {
    const url = String(input);
    if (url.startsWith("https://attacker.invalid/")) {
      return Response.json({ file: { uploadId } }, { status: 201 });
    }
    if (url.endsWith("/api/assets") && init?.method === "POST") {
      return Response.json({ asset: { id: assetId } }, { status: 201 });
    }
    if (init?.method === "PUT") return redirect();
    return new Response(null, { status: 204 });
  });
  const publishContext = harness({
    fetch: publishProbe.fetch,
    loadPublishInput: vi.fn(async () => ({
      entrypoint: "index.html",
      files: [
        {
          path: "index.html",
          bytes: new TextEncoder().encode("safe"),
          contentType: "text/html; charset=utf-8",
        },
      ],
    })),
  });
  expect(
    await runCli(
      ["publish", "/artifact", "--name", "Redirected upload", "--json"],
      publishContext.dependencies,
    ),
  ).toBe(1);
  expect(JSON.parse(publishContext.stderr[0]).error.code).toBe("publish_failed");
  expect(publishProbe.requests.map(({ url }) => url)).toEqual([
    `${DEFAULT_ORIGIN}/api/assets`,
    `${DEFAULT_ORIGIN}/api/assets/${assetId}/files/index.html`,
    `${DEFAULT_ORIGIN}/api/assets/${assetId}`,
  ]);

  const verifyProbe = simulatedRedirectFetch((input) => {
    const url = String(input);
    if (url.startsWith("https://attacker.invalid/")) return new Response(null, { status: 200 });
    if (url.startsWith(DEFAULT_ORIGIN)) {
      return Response.json({ asset: { id: assetId, state: "live" } });
    }
    return redirect();
  });
  const verifyContext = harness({ fetch: verifyProbe.fetch });
  expect(await runCli(["verify", assetId, "--json"], verifyContext.dependencies)).toBe(1);
  expect(JSON.parse(verifyContext.stderr[0]).error).toMatchObject({
    code: "verification_failed",
    status: 302,
  });
  expect(verifyProbe.requests.map(({ url }) => url)).toEqual([
    `${DEFAULT_ORIGIN}/api/assets/${assetId}`,
    `https://private.example.com/assets/${assetId}/`,
  ]);

  for (const probe of [apiProbe, connectProbe, publishProbe, verifyProbe]) {
    expect(probe.requests.some(({ url }) => url.startsWith("https://attacker.invalid/"))).toBe(
      false,
    );
    expect(probe.requests.every(({ headers }) => headers.has("CF-Access-Client-Secret"))).toBe(
      true,
    );
  }
});

test("owner API rejects the full 3xx status range", async () => {
  for (const status of [300, 301, 302, 303, 304, 305, 306, 307, 308, 399]) {
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
        new Response(null, { status }),
    );
    const context = harness({ fetch });

    expect(await runCli(["status", "--json"], context.dependencies)).toBe(1);
    expect(JSON.parse(context.stderr[0]).error).toMatchObject({ code: "api_error", status });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1]?.redirect).toBe("manual");
  }
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
