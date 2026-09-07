// @vitest-environment node
import { expect, test, vi } from "vitest";

import { runCli } from "../cli";
import { DEFAULT_ENV, harness } from "./test-harness.ts";

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
