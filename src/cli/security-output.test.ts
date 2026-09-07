// @vitest-environment node
import { expect, test, vi } from "vitest";

import { runCli } from "../cli";
import { encodeConnectionCredential } from "../cli-connection.ts";
import {
  DEFAULT_ENV,
  DEFAULT_ORIGIN,
  assetId,
  harness,
  simulatedRedirectFetch,
  storedCredential,
  uploadId,
} from "./test-harness.ts";

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
