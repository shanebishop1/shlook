import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { handleRequest } from "./index";

const origin = "https://show.test";

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

async function request(pathname: string, init?: RequestInit): Promise<Response> {
  return handleRequest(new Request(`${origin}${pathname}`, init), env);
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
    const response = await handleRequest(new Request("https://show.test/health"), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "shlook" });
  });

  it("rejects unknown routes", async () => {
    const response = await handleRequest(new Request("https://show.test/missing"), env);

    expect(response.status).toBe(404);
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
    expect((await request("/latest")).status).toBe(404);
    expect((await request(`/assets/${asset.id}/`)).status).toBe(404);
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
    expect(await (await request(`/assets/${asset.id}/`)).text()).toBe(
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

    const entrypoint = await request(`/assets/${asset.id}/`);
    const stylesheet = await request(`/assets/${asset.id}/assets/site.css`);

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

    expect(await (await request("/latest")).text()).toBe("second");
    expect((await request(`/api/assets/${second.id}`, { method: "DELETE" })).status).toBe(204);
    expect(await (await request("/latest")).text()).toBe("first");
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
    expect((await request(`/assets/${deleted.id}/`)).status).toBe(404);
    expect(await (await request(`/assets/${sibling.id}/`)).text()).toBe("keep me");
  });
});
