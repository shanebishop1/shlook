// @vitest-environment node
import { expect, test, vi } from "vitest";

import { runCli } from "../cli";
import { DEFAULT_ENV, DEFAULT_ORIGIN, assetId, harness, uploadId } from "./test-harness.ts";

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
