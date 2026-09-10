// @vitest-environment node
import { expect, test, vi } from "vitest";

import type { ConnectionCredential } from "../../cli-connection.ts";
import { SetupRuntimeError } from "../../cli-setup-runtime.ts";
import { verifyDeployment } from "./verification.ts";
import { ACCESS_SECRET, applied } from "./persistence-test-fixtures.ts";
import { runtimeHarness } from "./runtime-test-harness.ts";

const credential: ConnectionCredential = {
  domain: "example.com",
  accessClientId: "access-client-id",
  accessClientSecret: ACCESS_SECRET,
};

function responseFor(
  url: URL,
  authenticated: boolean,
  wrongBody: "health" | "private" | undefined,
): Response {
  if (url.origin === applied.origins.owner) {
    if (url.pathname === "/health") {
      return authenticated
        ? Response.json(
            wrongBody === "health"
              ? { ok: true, service: "not-shlook" }
              : { ok: true, service: "shlook" },
          )
        : new Response(null, { status: 403 });
    }
    return authenticated
      ? Response.json({ error: "not_found" }, { status: 404 })
      : new Response(null, { status: 403 });
  }
  if (url.origin === applied.origins.private) {
    if (authenticated) {
      return Response.json(wrongBody === "private" ? { error: "wrong" } : { error: "not_found" }, {
        status: 404,
      });
    }
    return new Response(null, { status: 403 });
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}

test.each(["health", "private"] as const)(
  "rejects an identifiable endpoint with the wrong %s JSON body",
  async (wrongBody) => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const authenticated = new Headers(init?.headers).has("CF-Access-Client-Id");
      return responseFor(url, authenticated, wrongBody);
    });
    const context = runtimeHarness({ fetch });

    await expect(verifyDeployment(applied, credential, context.dependencies)).rejects.toMatchObject(
      { code: "setup_verification_failed" },
    );
    expect(fetch).toHaveBeenCalledTimes(36);
  },
);

test.each(["owner", "private"] as const)(
  "rejects an unauthenticated %s origin that returns 200",
  async (surface) => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const authenticated = new Headers(init?.headers).has("CF-Access-Client-Id");
      if (!authenticated && url.origin === applied.origins[surface]) {
        return Response.json({ ok: true });
      }
      return responseFor(url, authenticated, undefined);
    });
    const context = runtimeHarness({ fetch });

    await expect(verifyDeployment(applied, credential, context.dependencies)).rejects.toMatchObject(
      {
        code: "setup_verification_failed",
      },
    );
    expect(fetch).toHaveBeenCalledTimes(36);
  },
);

test.each(["public", "share"] as const)(
  "rejects an Access challenge on the %s origin",
  async (surface) => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const authenticated = new Headers(init?.headers).has("CF-Access-Client-Id");
      if (url.origin === applied.origins[surface]) {
        return new Response("<html>Access challenge</html>", {
          status: 302,
          headers: { location: "https://access.example.com" },
        });
      }
      return responseFor(url, authenticated, undefined);
    });
    const context = runtimeHarness({ fetch });

    await expect(verifyDeployment(applied, credential, context.dependencies)).rejects.toMatchObject(
      {
        code: "setup_verification_failed",
      },
    );
    expect(fetch).toHaveBeenCalledTimes(36);
    expect(fetch.mock.calls.every((call) => call[1]?.redirect === "manual")).toBe(true);
  },
);

test.each(["content-type", "malformed", "oversized"] as const)(
  "rejects a health response with the wrong %s",
  async (body) => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const authenticated = new Headers(init?.headers).has("CF-Access-Client-Id");
      if (authenticated && url.origin === applied.origins.owner && url.pathname === "/health") {
        if (body === "oversized") {
          return new Response("x".repeat(1_025), {
            headers: { "content-type": "application/json", "content-length": "1025" },
          });
        }
        if (body === "malformed") {
          return new Response("{", { headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ ok: true, service: "shlook" }), {
          headers: { "content-type": "text/plain" },
        });
      }
      return responseFor(url, authenticated, undefined);
    });
    const context = runtimeHarness({ fetch });

    await expect(verifyDeployment(applied, credential, context.dependencies)).rejects.toMatchObject(
      {
        code: "setup_verification_failed",
      },
    );
    expect(fetch).toHaveBeenCalledTimes(36);
  },
);

test("retries unavailable verification without exposing the fetch failure", async () => {
  const fetch = vi.fn(async () => {
    throw new Error(`network failure containing ${ACCESS_SECRET}`);
  });
  const context = runtimeHarness({ fetch });
  const error = await verifyDeployment(applied, credential, context.dependencies).catch(
    (cause: unknown) => cause,
  );

  expect(error).toBeInstanceOf(SetupRuntimeError);
  expect(error).toMatchObject({
    code: "setup_verification_failed",
    message: "deployed shlook access verification failed",
  });
  expect(fetch).toHaveBeenCalledTimes(36);
  expect(String(error)).not.toContain(ACCESS_SECRET);
});

test("aborts and cancels a streaming response that times out", async () => {
  vi.useFakeTimers();
  let bodyCancelled = false;
  let healthAttempts = 0;
  try {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const authenticated = new Headers(init?.headers).has("CF-Access-Client-Id");
      if (authenticated && url.origin === applied.origins.owner && url.pathname === "/health") {
        healthAttempts += 1;
        if (healthAttempts > 1) {
          return new Response("{", { headers: { "content-type": "application/json" } });
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel: () => {
              bodyCancelled = true;
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return responseFor(url, authenticated, undefined);
    });
    const context = runtimeHarness({ fetch });
    const operation = verifyDeployment(applied, credential, context.dependencies);
    const failure = expect(operation).rejects.toMatchObject({
      code: "setup_verification_failed",
    });

    await vi.runAllTimersAsync();
    await failure;
    expect(bodyCancelled).toBe(true);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});
