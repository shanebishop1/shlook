import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { cleanupExpired, handleRequest, type Env } from "./index";
import { handlePrivacyMutation } from "./privacy";

const ownerHost = "show.shane-bishop.com";
const privateHost = "private.show.shane-bishop.com";
const shareHost = "share.shane-bishop.com";
const worker = handleRequest as (
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
) => Promise<Response>;

function accessContext(email: string | null = "shaneebishop@gmail.com"): ExecutionContext {
  return {
    access: {
      aud: "test-audience",
      getIdentity: async () => (email === null ? undefined : { email }),
    },
  } as unknown as ExecutionContext;
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

interface AssetJson {
  id: string;
  state: "uploading" | "finalizing" | "live";
  visibility: "private";
  createdAt: string;
  updatedAt: string;
}

interface ManifestFile {
  path: string;
  uploadId: string;
}

async function request(
  pathname: string,
  init?: RequestInit,
  host = ownerHost,
  ctx: ExecutionContext | null = accessContext(),
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (
    host === ownerHost &&
    !["GET", "HEAD"].includes(init?.method ?? "GET") &&
    !headers.has("origin")
  ) {
    headers.set("x-shlook-client", "1");
  }
  return worker(
    new Request(`https://${host}${pathname}`, { ...init, headers }),
    env,
    ctx ?? undefined,
  );
}

async function createAsset(): Promise<AssetJson> {
  const response = await request("/api/assets", { method: "POST" });
  const body = (await response.json()) as { asset: AssetJson };
  return body.asset;
}

async function uploadFile(
  id: string,
  pathname: string,
  body: string,
  contentType = "text/plain",
): Promise<Response> {
  return request(`/api/assets/${id}/files/${pathname}`, {
    method: "PUT",
    headers: { "content-type": contentType },
    body,
  });
}

async function uploadedFile(response: Response): Promise<ManifestFile> {
  const body = (await response.json()) as { file: ManifestFile };
  return body.file;
}

async function finalizeAsset(id: string, files: ManifestFile[], entrypoint = files[0]?.path) {
  return request(`/api/assets/${id}/finalize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entrypoint, files }),
  });
}

async function createLiveAsset(contents: string): Promise<AssetJson> {
  const asset = await createAsset();
  const upload = await uploadFile(asset.id, "index.html", contents, "text/html");
  expect(upload.status).toBe(201);
  expect((await finalizeAsset(asset.id, [await uploadedFile(upload)])).status).toBe(200);
  return asset;
}

describe("worker bootstrap", () => {
  it("reports service health", async () => {
    const response = await request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "shlook" });
  });

  it("rejects unknown routes", async () => {
    const response = await request("/missing");

    expect(response.status).toBe(404);
  });

  it("renders a protected owner archive without weakening browser policy", async () => {
    const asset = await createLiveAsset("owner archive");
    const response = await request("/");
    const body = await response.text();

    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(body).toContain(asset.id);
    expect(body).toContain(`https://${privateHost}/assets/${asset.id}/`);
  });
});

describe("asset publication", () => {
  it("creates a private non-servable asset", async () => {
    const asset = await createAsset();

    expect(asset).toMatchObject({ state: "uploading", visibility: "private" });
    expect(asset.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(asset.createdAt)).not.toBeNaN();
  });

  it("hides uploading assets from archive, latest, and direct views", async () => {
    const asset = await createAsset();

    const archive = await request("/api/assets");
    await expect(archive.json()).resolves.toEqual({ assets: [], nextOffset: null });
    expect((await request("/api/assets?offset=-1")).status).toBe(400);
    expect((await request("/latest", undefined, privateHost)).status).toBe(404);
    expect((await request(`/assets/${asset.id}/`, undefined, privateHost)).status).toBe(404);
  });

  it("uploads safe files under asset-scoped keys and enforces the slot limit", async () => {
    const asset = await createAsset();
    const response = await uploadFile(asset.id, "images/card.txt", "card");

    expect(response.status).toBe(201);
    const file = await uploadedFile(response);
    const object = await env.ASSETS.get(`assets/${asset.id}/uploads/${file.uploadId}`);
    expect(await object?.text()).toBe("card");

    await env.DB.prepare("UPDATE assets SET upload_count = 500 WHERE id = ?").bind(asset.id).run();
    const capped = await uploadFile(asset.id, "overflow.txt", "overflow");
    expect(capped.status).toBe(409);
    await expect(capped.json()).resolves.toEqual({ error: "upload_limit_reached" });
  });

  it("rejects traversal and symlink uploads", async () => {
    const asset = await createAsset();

    const traversal = await uploadFile(asset.id, "%2e%2e%2fescape.txt", "escape");
    const symlink = await request(`/api/assets/${asset.id}/files/link`, {
      method: "PUT",
      headers: { "x-shlook-file-kind": "symlink" },
      body: "target",
    });

    expect(traversal.status).toBe(400);
    expect(symlink.status).toBe(400);
    expect((await env.ASSETS.list({ prefix: `assets/${asset.id}/` })).objects).toHaveLength(0);
  });

  it("claims finalization atomically and writes its complete manifest before going live", async () => {
    const asset = await createAsset();
    const missing = { path: "missing.html", uploadId: crypto.randomUUID() };

    const oversized = await request(`/api/assets/${asset.id}/finalize`, {
      method: "POST",
      body: JSON.stringify({ padding: "x".repeat(1024 * 1024) }),
    });
    expect(oversized.status).toBe(400);
    expect((await finalizeAsset(asset.id, [missing])).status).toBe(409);
    const firstUpload = await uploadFile(asset.id, "first.html", "first", "text/html");
    const secondUpload = await uploadFile(asset.id, "second.html", "second", "text/html");
    const firstFile = await uploadedFile(firstUpload);
    const secondFile = await uploadedFile(secondUpload);
    await env.DB.prepare(
      "UPDATE assets SET state = 'finalizing', finalize_token = ?, finalize_started_at = ? WHERE id = ?",
    )
      .bind("stale-attempt", "2026-08-26T00:00:00.000Z", asset.id)
      .run();

    const responses = await Promise.all([
      finalizeAsset(asset.id, [firstFile]),
      finalizeAsset(asset.id, [secondFile]),
    ]);
    const winner = responses[0].status === 200 ? firstFile : secondFile;
    const liveRow = await env.DB.prepare("SELECT manifest_id FROM assets WHERE id = ?")
      .bind(asset.id)
      .first<{ manifest_id: string }>();
    const manifest = await env.ASSETS.get(
      `assets/${asset.id}/manifests/${liveRow?.manifest_id}.json`,
    );
    const inspected = await request(`/api/assets/${asset.id}`);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    await expect(manifest?.json()).resolves.toEqual({
      version: 1,
      entrypoint: winner.path,
      files: [winner],
    });
    await expect(inspected.json()).resolves.toMatchObject({ asset: { state: "live" } });
    expect((await uploadFile(asset.id, winner.path, "overwrite", "text/html")).status).toBe(409);
    expect(await (await request(`/assets/${asset.id}/`, undefined, privateHost)).text()).toBe(
      winner === firstFile ? "first" : "second",
    );
  });

  it("inspects one asset and lists the live archive newest first", async () => {
    const first = await createLiveAsset("first");
    const second = await createLiveAsset("second");
    await env.DB.batch([
      env.DB.prepare("UPDATE assets SET created_at = ? WHERE id = ?").bind(
        "2026-08-26T01:00:00.000Z",
        first.id,
      ),
      env.DB.prepare("UPDATE assets SET created_at = ? WHERE id = ?").bind(
        "2026-08-26T02:00:00.000Z",
        second.id,
      ),
    ]);

    const inspected = await request(`/api/assets/${first.id}`);
    const archive = await request("/api/assets");

    await expect(inspected.json()).resolves.toMatchObject({
      asset: { id: first.id, state: "live" },
    });
    const body = (await archive.json()) as { assets: AssetJson[] };
    expect(body.assets.map((asset) => asset.id)).toEqual([second.id, first.id]);
  });

  it("serves direct entrypoint and nested files with stored metadata", async () => {
    const asset = await createAsset();
    const entrypointFile = await uploadedFile(
      await uploadFile(asset.id, "index.html", "<h1>site</h1>", "text/html"),
    );
    const stylesheetFile = await uploadedFile(
      await uploadFile(asset.id, "assets/site.css", "h1{}", "text/css"),
    );
    await finalizeAsset(asset.id, [entrypointFile, stylesheetFile], "index.html");

    const entrypoint = await request(`/assets/${asset.id}/`, undefined, privateHost);
    const stylesheet = await request(`/assets/${asset.id}/assets/site.css`, undefined, privateHost);

    expect(await entrypoint.text()).toBe("<h1>site</h1>");
    expect(entrypoint.headers.get("content-type")).toBe("text/html");
    expect(await stylesheet.text()).toBe("h1{}");
    expect(stylesheet.headers.get("content-type")).toBe("text/css");
  });

  it("serves the latest live asset and falls back after deletion", async () => {
    const first = await createLiveAsset("first");
    const second = await createLiveAsset("second");
    await env.DB.batch([
      env.DB.prepare("UPDATE assets SET created_at = ? WHERE id = ?").bind(
        "2026-08-26T01:00:00.000Z",
        first.id,
      ),
      env.DB.prepare("UPDATE assets SET created_at = ? WHERE id = ?").bind(
        "2026-08-26T02:00:00.000Z",
        second.id,
      ),
    ]);

    expect(await (await request("/latest", undefined, privateHost)).text()).toBe("second");
    expect((await request(`/api/assets/${second.id}`, { method: "DELETE" })).status).toBe(204);
    expect(await (await request("/latest", undefined, privateHost)).text()).toBe("first");
  });

  it("deletes exactly one asset while preserving its sibling", async () => {
    const deleted = await createLiveAsset("delete me");
    const sibling = await createLiveAsset("keep me");
    await env.ASSETS.put(`assets/${deleted.id}/manifests/interrupted.json`, "stale");

    expect((await request(`/api/assets/${deleted.id}`, { method: "DELETE" })).status).toBe(204);

    expect((await env.ASSETS.list({ prefix: `assets/${deleted.id}/` })).objects).toHaveLength(0);
    expect(
      (await env.ASSETS.list({ prefix: `assets/${sibling.id}/uploads/` })).objects,
    ).toHaveLength(1);
    expect((await request(`/assets/${deleted.id}/`, undefined, privateHost)).status).toBe(404);
    expect(await (await request(`/assets/${sibling.id}/`, undefined, privateHost)).text()).toBe(
      "keep me",
    );
  });
});

describe("privacy and lifecycle", () => {
  it("returns not found for every unknown host", async () => {
    expect((await request("/health", undefined, "worker.example.com")).status).toBe(404);
    expect((await request("/api/assets", undefined, "worker.example.com")).status).toBe(404);
  });

  it("requires verified Access context and the accepted owner identity", async () => {
    expect((await request("/health", undefined, ownerHost, null)).status).toBe(403);
    expect(
      (await request("/health", undefined, ownerHost, accessContext("other@example.com"))).status,
    ).toBe(403);
    expect((await request("/health", undefined, ownerHost, accessContext(null))).status).toBe(200);
  });

  it("redirects owner artifact views away from the mutation origin", async () => {
    const asset = await createLiveAsset("private");
    const response = await request(`/assets/${asset.id}/`, { redirect: "manual" });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`https://${privateHost}/assets/${asset.id}/`);
  });

  it("requires Access for private-host artifacts", async () => {
    const asset = await createLiveAsset("private");

    expect((await request(`/assets/${asset.id}/`, undefined, privateHost, null)).status).toBe(403);
    expect(await (await request(`/assets/${asset.id}/`, undefined, privateHost)).text()).toBe(
      "private",
    );
  });

  it("keeps owner API mutations off artifact hosts", async () => {
    expect((await request("/api/assets", { method: "POST" }, privateHost)).status).toBe(404);
    expect((await request("/api/assets", { method: "POST" }, shareHost, undefined)).status).toBe(
      404,
    );
    expect(
      (
        await request("/api/assets", {
          method: "POST",
          headers: { origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
  });

  it("serves explicitly public HTML only from the sandboxed share host", async () => {
    const asset = await createLiveAsset("<h1>public</h1>");
    const visibility = await request(`/api/assets/${asset.id}/visibility`, {
      method: "PATCH",
      body: JSON.stringify({ visibility: "public" }),
    });

    expect(visibility.status).toBe(200);
    const shared = await request(`/assets/${asset.id}/`, undefined, shareHost, undefined);
    expect(await shared.text()).toBe("<h1>public</h1>");
    expect(shared.headers.get("content-security-policy")).toContain("sandbox");

    const svg = await createAsset();
    const svgUpload = await uploadFile(svg.id, "image.svg", "<svg/>", "Image/SVG+XML");
    await finalizeAsset(svg.id, [await uploadedFile(svgUpload)], "image.svg");
    await request(`/api/assets/${svg.id}/visibility`, {
      method: "PATCH",
      body: JSON.stringify({ visibility: "public" }),
    });
    const sharedSvg = await request(`/assets/${svg.id}/`, undefined, shareHost, undefined);
    expect(sharedSvg.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("stores only a hash and serves a newly issued secret capability", async () => {
    const asset = await createLiveAsset("secret");
    const issued = await request(`/api/assets/${asset.id}/secret?mode=create`, { method: "POST" });
    const body = (await issued.json()) as { secret: string; url: string };
    const row = await env.DB.prepare("SELECT secret_hash FROM assets WHERE id = ?")
      .bind(asset.id)
      .first<{ secret_hash: string }>();

    expect(body.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(row?.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.secret_hash).not.toBe(body.secret);
    expect((await request(`/assets/${asset.id}/`, undefined, shareHost, undefined)).status).toBe(
      404,
    );
    expect(
      await (await request(new URL(body.url).pathname, undefined, shareHost, undefined)).text(),
    ).toBe("secret");
  });

  it("rotates and revokes secret capabilities", async () => {
    const asset = await createLiveAsset("secret");
    const first = (await (
      await request(`/api/assets/${asset.id}/secret?mode=create`, { method: "POST" })
    ).json()) as { url: string };
    expect(
      (await request(`/api/assets/${asset.id}/secret?mode=create`, { method: "POST" })).status,
    ).toBe(409);
    const second = (await (
      await request(`/api/assets/${asset.id}/secret?mode=rotate`, { method: "POST" })
    ).json()) as { url: string };

    expect(
      (await request(new URL(first.url).pathname, undefined, shareHost, undefined)).status,
    ).toBe(404);
    expect(
      (await request(new URL(second.url).pathname, undefined, shareHost, undefined)).status,
    ).toBe(200);
    expect((await request(`/api/assets/${asset.id}/secret`, { method: "DELETE" })).status).toBe(
      204,
    );
    expect(
      (await request(new URL(second.url).pathname, undefined, shareHost, undefined)).status,
    ).toBe(404);
  });

  it("expires sharing without removing private owner access", async () => {
    const asset = await createLiveAsset("expired share");
    await request(`/api/assets/${asset.id}/visibility`, {
      method: "PATCH",
      body: JSON.stringify({ visibility: "public" }),
    });
    await request(`/api/assets/${asset.id}/expiry`, {
      method: "PATCH",
      body: JSON.stringify({ hardExpiresAt: "2999-01-01T00:00:00.000Z" }),
    });
    await request(`/api/assets/${asset.id}/expiry`, {
      method: "PATCH",
      body: JSON.stringify({ shareExpiresAt: "2000-01-01T00:00:00.000Z" }),
    });

    expect((await request(`/assets/${asset.id}/`, undefined, shareHost, undefined)).status).toBe(
      404,
    );
    expect(await (await request(`/assets/${asset.id}/`, undefined, privateHost)).text()).toBe(
      "expired share",
    );
    const row = await env.DB.prepare("SELECT hard_expires_at FROM assets WHERE id = ?")
      .bind(asset.id)
      .first<{ hard_expires_at: string }>();
    expect(row?.hard_expires_at).toBe("2999-01-01T00:00:00.000Z");
  });

  it("hard-expires logical access before cleaning the exact asset", async () => {
    const asset = await createLiveAsset("hard expired");
    await request(`/api/assets/${asset.id}/expiry`, {
      method: "PATCH",
      body: JSON.stringify({ hardExpiresAt: "2000-01-01T00:00:00.000Z" }),
    });

    expect((await request(`/assets/${asset.id}/`, undefined, privateHost)).status).toBe(404);
    const row = await env.DB.prepare("SELECT state, cleanup_pending FROM assets WHERE id = ?")
      .bind(asset.id)
      .first<{ state: string; cleanup_pending: number }>();
    expect(row?.state).toBe("deleted");
    expect(row?.cleanup_pending).toBe(1);
    expect((await env.ASSETS.list({ prefix: `assets/${asset.id}/` })).objects).toHaveLength(0);

    await env.ASSETS.put(`assets/${asset.id}/manifests/late.json`, "late");
    await cleanupExpired(env);
    expect((await env.ASSETS.list({ prefix: `assets/${asset.id}/` })).objects).toHaveLength(0);
    await cleanupExpired(env);
    const cleaned = await env.DB.prepare("SELECT cleanup_pending FROM assets WHERE id = ?")
      .bind(asset.id)
      .first<{ cleanup_pending: number }>();
    expect(cleaned?.cleanup_pending).toBe(0);

    const stale = await createLiveAsset("stale mutation");
    await env.DB.prepare("UPDATE assets SET hard_expires_at = ? WHERE id = ?")
      .bind("2000-01-01T00:00:00.000Z", stale.id)
      .run();
    const staleUpdate = await handlePrivacyMutation(
      new Request(`https://${ownerHost}/api/assets/${stale.id}/expiry`, {
        method: "PATCH",
        body: JSON.stringify({ hardExpiresAt: null }),
      }),
      env.DB,
      {
        id: stale.id,
        state: "live",
        visibility: "private",
        secret_hash: null,
        share_expires_at: null,
        hard_expires_at: null,
      },
      "expiry",
    );
    expect(staleUpdate?.status).toBe(409);

    const scheduled = await createLiveAsset("scheduled expiry");
    await env.DB.prepare("UPDATE assets SET hard_expires_at = ? WHERE id = ?")
      .bind("2000-01-01T00:00:00.000Z", scheduled.id)
      .run();
    await cleanupExpired(env);
    const scheduledRow = await env.DB.prepare("SELECT state FROM assets WHERE id = ?")
      .bind(scheduled.id)
      .first<{ state: string }>();
    expect(scheduledRow?.state).toBe("deleted");
  });
});
