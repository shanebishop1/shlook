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
      "INSERT INTO assets (id, name, description, state, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        id,
        "Forest <release>",
        "A calm & searchable archive entry",
        "live",
        "private",
        now,
        now,
      )
      .run();
    const response = await request("/");
    const body = await response.text();

    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-src https://private.example.com",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "img-src https://private.example.com",
    );
    expect(body).toContain(id);
    expect(body).toContain("Forest &lt;release&gt;");
    expect(body).toContain("A calm &amp; searchable archive entry");
    expect(body).not.toContain("Forest <release>");
    expect(body).toContain(`https://private.example.com/assets/${id}/`);
    expect(body).toContain('class="ledger"');
    expect(body).toContain('class="preview-frame"');
    expect(body).toContain("data-preview-image");
    expect(body).toContain("data-preview-fallback");
    expect(body).toContain('sandbox="allow-same-origin"');
    expect(body).toContain("data-inspect");
    expect(body).toContain("data-search");
    expect(body).toContain("data-search-text");
    expect(body).toContain("row.dataset.search=row.dataset.searchText+' '+value");
    expect(body).toContain("data-row-visibility");
    expect(body).toContain("data-filter-option");
    expect(body).toContain('aria-haspopup="listbox"');
    expect(body).toContain('class="artifact-link"');
    expect(body).toContain("data-theme-toggle");
    expect(body).toContain('data-copy-public aria-label="Copy share link"');
    expect(body).toContain("data-copy-row");
    expect(body).toContain("data-secret-url");
    expect(body).toContain(
      "path.startsWith('/secret?')&&typeof body.url==='string')card.dataset.secretUrl=body.url",
    );
    expect(body).toContain(
      "syncVisibility(id,value);menu.querySelector('[data-menu-button]').disabled=true",
    );
    expect(body).toContain(".visibility-select .custom-trigger:disabled{cursor:wait;opacity:1}");
    expect(body).toContain("Share expiration");
    expect(body).toContain("Artifact expiration");
    expect(body).toContain("Clear expirations");
    expect(body).toContain("Artifact no longer exists. Refreshing...");
    expect(body).toContain("card.dataset.detail+path");
    expect(body).not.toContain("card.dataset.id+path");
    expect(body).toContain("Artifact archive");
    expect(body).toContain('placeholder="Search name, description, or ID"');
    expect(body).not.toContain("<select");
    expect(body).not.toContain("Share expires");
    expect(body).not.toContain("Hard expires");
    expect(body).not.toContain("Clear expiries");
    expect(body).not.toContain(">Copy link</button>");
    expect(body).not.toContain("Latest transmission");
    expect(body).not.toContain("No live artifacts in the ledger.");
    const script = body.match(/<script nonce="[^"]+">([\s\S]+)<\/script>/)?.[1];
    expect(script).toBeDefined();
    expect(() => new Function(script ?? "")).not.toThrow();
  });
});
