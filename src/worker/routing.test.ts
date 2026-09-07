import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { deploymentConfig } from "../privacy";
import {
  accessContext,
  createAsset,
  createLiveAsset,
  finalizeAsset,
  ownerHost,
  privateHost,
  publicHost,
  request,
  shareHost,
  uploadFile,
  uploadedFile,
  type AssetJson,
} from "../test-harness";
import { setupWorkerTestDatabase } from "./test-setup";

setupWorkerTestDatabase();

describe("asset publication", () => {
  it("creates a private non-servable asset", async () => {
    const asset = await createAsset("  Release preview  ", "  Owner UI refinement  ");

    expect(asset).toMatchObject({
      name: "Release preview",
      description: "Owner UI refinement",
      state: "uploading",
      visibility: "private",
    });
    expect(asset.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(asset.createdAt)).not.toBeNaN();
    await expect(
      env.DB.prepare("SELECT name, description FROM assets WHERE id = ?").bind(asset.id).first(),
    ).resolves.toEqual({ name: "Release preview", description: "Owner UI refinement" });
  });

  it("validates asset metadata while preserving bodyless client compatibility", async () => {
    const invalid = [
      { name: "   " },
      { name: "x".repeat(81) },
      { name: "Valid", description: "x".repeat(501) },
      { name: 42 },
    ];
    for (const body of invalid) {
      const response = await request("/api/assets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_asset_metadata" });
    }

    const legacy = await request("/api/assets", { method: "POST" });
    expect(legacy.status).toBe(201);
    const legacyBody = (await legacy.json()) as { asset: AssetJson };
    expect(legacyBody.asset.name).toBe(legacyBody.asset.id.slice(0, 8));
    expect(legacyBody.asset.description).toBeNull();
  });

  it("hides uploading assets from archive, latest, and direct views", async () => {
    const asset = await createAsset();

    const archive = await request("/api/assets");
    await expect(archive.json()).resolves.toEqual({ assets: [], nextOffset: null });
    expect((await request("/api/assets?offset=-1")).status).toBe(400);
    expect((await request("/latest", undefined, privateHost)).status).toBe(404);
    expect((await request(`/assets/${asset.id}/`, undefined, privateHost)).status).toBe(404);
  });

  it("inspects one asset and lists the live archive newest first", async () => {
    const first = await createLiveAsset("first", "First concept", "Quiet archive direction");
    const second = await createLiveAsset("second", "Second concept");
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
      asset: {
        id: first.id,
        name: "First concept",
        description: "Quiet archive direction",
        state: "live",
      },
    });
    const body = (await archive.json()) as { assets: AssetJson[] };
    expect(body.assets.map((asset) => asset.id)).toEqual([second.id, first.id]);
    expect(body.assets.map(({ name, description }) => ({ name, description }))).toEqual([
      { name: "Second concept", description: null },
      { name: "First concept", description: "Quiet archive direction" },
    ]);
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
    expect(() =>
      deploymentConfig({
        SHLOOK_OWNER_ORIGIN: "https://owner.example.com",
        SHLOOK_PRIVATE_ORIGIN: "https://private.example.com",
        SHLOOK_PUBLIC_ORIGIN: "https://share.example.com",
        SHLOOK_SHARE_ORIGIN: "https://share.example.com",
        SHLOOK_OWNER_EMAIL: "owner@example.com",
      }),
    ).toThrow("four distinct origins");
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

  it("serves isolated artifact previews only through the authenticated owner origin", async () => {
    const asset = await createLiveAsset("<h1>private preview</h1>");
    const path = `/preview/assets/${asset.id}/`;

    expect((await request(path, undefined, ownerHost, null)).status).toBe(403);
    expect((await request(path, undefined, privateHost)).status).toBe(404);
    expect((await request(path, undefined, publicHost, null)).status).toBe(404);
    expect((await request(path, undefined, shareHost, null)).status).toBe(404);

    const response = await request(path);
    const policy = response.headers.get("content-security-policy") ?? "";
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<h1>private preview</h1>");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(policy).toContain("sandbox allow-scripts");
    expect(policy).not.toContain("allow-same-origin");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("frame-ancestors 'self'");
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
    expect((await request("/api/assets", { method: "POST" }, publicHost, undefined)).status).toBe(
      404,
    );
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

  it("keeps the owner favicon off artifact hosts", async () => {
    expect((await request("/favicon.svg", undefined, privateHost)).status).toBe(404);
    expect((await request("/favicon.svg", undefined, publicHost, null)).status).toBe(404);
    expect((await request("/favicon.svg", undefined, shareHost, null)).status).toBe(404);
  });

  it("rejects owner API requests embedded as passive browser resources", async () => {
    expect(
      (
        await request("/api/assets", {
          headers: { "sec-fetch-dest": "image" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/api/assets", {
          headers: { "sec-fetch-dest": "iframe" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/api/assets", {
          headers: { "sec-fetch-dest": "empty", "sec-fetch-site": "cross-site" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/api/assets", {
          headers: { "sec-fetch-dest": "empty", "sec-fetch-site": "same-origin" },
        })
      ).status,
    ).toBe(200);
    expect((await request("/api/assets")).status).toBe(200);
  });
});
