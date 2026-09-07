// @vitest-environment node
import { expect, test, vi } from "vitest";

import { runCli } from "../cli";
import { encodeConnectionCredential } from "../cli-connection.ts";
import { DEFAULT_ENV, DEFAULT_ORIGIN, harness, storedCredential } from "./test-harness.ts";

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
