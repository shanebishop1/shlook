import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { handleRequest, type Env } from "./index";

const worker = handleRequest as (
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
) => Promise<Response>;
const access = {
  access: {
    aud: "test-audience",
    getIdentity: async () => ({ email: "owner@example.com" }),
  },
} as unknown as ExecutionContext;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

function request(path: string): Promise<Response> {
  return worker(new Request(`https://owner.example.com${path}`), env, access);
}

describe("worker bootstrap", () => {
  it("reports service health", async () => {
    const response = await request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "shlook" });
  });

  it("rejects unknown routes", async () => {
    expect((await request("/missing")).status).toBe(404);
  });

  it("renders a protected owner archive without weakening browser policy", async () => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO assets (id, state, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(id, "live", "private", now, now)
      .run();
    const response = await request("/");
    const body = await response.text();

    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-src https://private.example.com",
    );
    expect(body).toContain(id);
    expect(body).toContain(`https://private.example.com/assets/${id}/`);
    expect(body).toContain('class="ledger"');
    expect(body).toContain('class="preview-frame"');
    expect(body).toContain('sandbox="allow-same-origin"');
    expect(body).toContain("data-inspect");
    expect(body).toContain("data-search");
    expect(body).toContain("Artifact archive");
    expect(body).not.toContain("Latest transmission");
    expect(body).not.toContain("No live artifacts in the ledger.");
  });
});
