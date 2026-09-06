import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupExpired } from "./index";
import { deploymentConfig, handlePrivacyMutation, hashSecret } from "./privacy";
import { decryptSecret } from "./secret-crypto";
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
  uploadedFile,
  uploadFile,
  type AssetJson,
} from "./test-harness";
import { maxPublicationBytes, maxUploadBytes } from "./upload-limits";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

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

  it("uploads safe files under asset-scoped keys and enforces the slot limit", async () => {
    const asset = await createAsset();
    const response = await uploadFile(asset.id, "images/card.txt", "card");

    expect(response.status).toBe(201);
    const file = await uploadedFile(response);
    const object = await env.ASSETS.get(`assets/${asset.id}/uploads/${file.uploadId}`);
    expect(await object?.text()).toBe("card");
    await expect(
      env.DB.prepare("SELECT upload_count, upload_bytes FROM assets WHERE id = ?")
        .bind(asset.id)
        .first(),
    ).resolves.toEqual({ upload_count: 1, upload_bytes: 4 });

    await env.DB.prepare("UPDATE assets SET upload_count = 500 WHERE id = ?").bind(asset.id).run();
    const capped = await uploadFile(asset.id, "overflow.txt", "overflow");
    expect(capped.status).toBe(409);
    await expect(capped.json()).resolves.toEqual({ error: "upload_limit_reached" });
  });

  it("requires a valid length and enforces both file and publication byte limits", async () => {
    const asset = await createAsset();
    const missing = await request(`/api/assets/${asset.id}/files/missing.txt`, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "missing length",
    });
    const invalid = await request(`/api/assets/${asset.id}/files/invalid.txt`, {
      method: "PUT",
      headers: { "content-type": "text/plain", "content-length": "not-a-number" },
      body: "invalid length",
    });
    const oversized = await request(`/api/assets/${asset.id}/files/oversized.txt`, {
      method: "PUT",
      headers: { "content-length": String(maxUploadBytes + 1) },
    });

    expect(missing.status).toBe(411);
    await expect(missing.json()).resolves.toEqual({ error: "content_length_required" });
    expect(invalid.status).toBe(411);
    await expect(invalid.json()).resolves.toEqual({ error: "content_length_required" });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({ error: "upload_file_too_large" });

    await env.DB.prepare("UPDATE assets SET upload_bytes = ? WHERE id = ?")
      .bind(maxPublicationBytes - 1, asset.id)
      .run();
    const total = await uploadFile(asset.id, "total.txt", "two");
    expect(total.status).toBe(409);
    await expect(total.json()).resolves.toEqual({ error: "upload_bytes_limit_reached" });
  });

  it("releases reserved count and bytes when R2 rejects or returns the wrong size", async () => {
    const rejectedAsset = await createAsset();
    const rejectedPut = vi.spyOn(env.ASSETS, "put").mockRejectedValueOnce(new Error("R2 failed"));
    const rejectedDelete = vi
      .spyOn(env.ASSETS, "delete")
      .mockRejectedValueOnce(new Error("R2 cleanup failed"));
    try {
      const rejected = await uploadFile(rejectedAsset.id, "rejected.txt", "rejected");
      expect(rejected.status).toBe(500);
      await expect(rejected.json()).resolves.toEqual({ error: "internal_error" });
      await expect(
        env.DB.prepare("SELECT upload_count, upload_bytes FROM assets WHERE id = ?")
          .bind(rejectedAsset.id)
          .first(),
      ).resolves.toEqual({ upload_count: 0, upload_bytes: 0 });
    } finally {
      rejectedPut.mockRestore();
      rejectedDelete.mockRestore();
    }

    const mismatchAsset = await createAsset();
    const mismatchPut = vi.spyOn(env.ASSETS, "put").mockResolvedValueOnce({ size: 99 } as R2Object);
    try {
      const mismatch = await uploadFile(mismatchAsset.id, "mismatch.txt", "actual");
      expect(mismatch.status).toBe(502);
      await expect(mismatch.json()).resolves.toEqual({ error: "upload_size_mismatch" });
      await expect(
        env.DB.prepare("SELECT upload_count, upload_bytes FROM assets WHERE id = ?")
          .bind(mismatchAsset.id)
          .first(),
      ).resolves.toEqual({ upload_count: 0, upload_bytes: 0 });
      expect(
        (await env.ASSETS.list({ prefix: `assets/${mismatchAsset.id}/` })).objects,
      ).toHaveLength(0);
    } finally {
      mismatchPut.mockRestore();
    }

    const lookupAsset = await createAsset();
    const originalLookupPut = env.ASSETS.put.bind(env.ASSETS);
    const lookupPut = vi.spyOn(env.ASSETS, "put").mockImplementationOnce(async (...args) => {
      const result = await originalLookupPut(...args);
      await env.DB.prepare("DROP TABLE assets").run();
      return result;
    });
    try {
      const lookupFailure = await uploadFile(lookupAsset.id, "lookup.txt", "lookup");
      expect(lookupFailure.status).toBe(500);
      await expect(lookupFailure.json()).resolves.toEqual({ error: "internal_error" });
      expect((await env.ASSETS.list({ prefix: `assets/${lookupAsset.id}/` })).objects).toHaveLength(
        0,
      );
    } finally {
      lookupPut.mockRestore();
    }
  });

  it("rolls back an upload when finalization races its state", async () => {
    const asset = await createAsset();
    const originalPut = env.ASSETS.put.bind(env.ASSETS);
    const racedPut = vi.spyOn(env.ASSETS, "put").mockImplementationOnce(async (...args) => {
      const result = await originalPut(...args);
      await env.DB.prepare("UPDATE assets SET state = 'finalizing' WHERE id = ?")
        .bind(asset.id)
        .run();
      return result;
    });
    try {
      const response = await uploadFile(asset.id, "raced.txt", "raced");
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: "asset_not_uploading" });
      await expect(
        env.DB.prepare("SELECT upload_count, upload_bytes FROM assets WHERE id = ?")
          .bind(asset.id)
          .first(),
      ).resolves.toEqual({ upload_count: 0, upload_bytes: 0 });
      expect((await env.ASSETS.list({ prefix: `assets/${asset.id}/` })).objects).toHaveLength(0);
    } finally {
      racedPut.mockRestore();
    }
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

  it("backfills names when upgrading a populated database", async () => {
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, 3));
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO assets (id, state, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(id, "live", "private", now, now)
      .run();

    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(3));

    await expect(
      env.DB.prepare("SELECT name, description, upload_bytes FROM assets WHERE id = ?")
        .bind(id)
        .first(),
    ).resolves.toEqual({ name: id.slice(0, 8), description: null, upload_bytes: 0 });
    await expect(
      env.DB.prepare(
        "INSERT INTO assets (id, name, state, visibility, upload_bytes, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(crypto.randomUUID(), "Invalid", "uploading", "private", -1, now, now)
        .run(),
    ).rejects.toThrow();
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

  it("serves explicitly public HTML only from the sandboxed public host", async () => {
    const asset = await createLiveAsset("<h1>public</h1>");
    expect((await request(`/assets/${asset.id}/`, undefined, publicHost, undefined)).status).toBe(
      404,
    );
    const visibility = await request(`/api/assets/${asset.id}/visibility`, {
      method: "PATCH",
      body: JSON.stringify({ visibility: "public" }),
    });

    expect(visibility.status).toBe(200);
    const shared = await request(`/assets/${asset.id}/`, undefined, publicHost, undefined);
    expect(await shared.text()).toBe("<h1>public</h1>");
    expect(shared.headers.get("content-security-policy")).toContain("sandbox");

    const svg = await createAsset();
    const svgUpload = await uploadFile(svg.id, "image.svg", "<svg/>", "Image/SVG+XML");
    await finalizeAsset(svg.id, [await uploadedFile(svgUpload)], "image.svg");
    await request(`/api/assets/${svg.id}/visibility`, {
      method: "PATCH",
      body: JSON.stringify({ visibility: "public" }),
    });
    const sharedSvg = await request(`/assets/${svg.id}/`, undefined, publicHost, undefined);
    expect(sharedSvg.headers.get("content-security-policy")).toContain("sandbox");
    expect((await request(`/assets/${asset.id}/`, undefined, shareHost, undefined)).status).toBe(
      404,
    );
  });

  it("stores a hash plus encrypted recovery data and serves a newly issued secret capability", async () => {
    const asset = await createLiveAsset("secret");
    const issued = await request(`/api/assets/${asset.id}/secret?mode=create`, { method: "POST" });
    const body = (await issued.json()) as { secret: string; url: string };
    const row = await env.DB.prepare(
      "SELECT secret_hash, secret_ciphertext, secret_iv FROM assets WHERE id = ?",
    )
      .bind(asset.id)
      .first<{ secret_hash: string; secret_ciphertext: string; secret_iv: string }>();

    expect(body.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new URL(body.url).origin).toBe(`https://${shareHost}`);
    expect(row?.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.secret_hash).not.toBe(body.secret);
    expect(row?.secret_ciphertext).not.toContain(body.secret);
    await expect(
      decryptSecret(
        row?.secret_ciphertext ?? "",
        row?.secret_iv ?? "",
        asset.id,
        env.SHLOOK_SECRET_ENCRYPTION_KEY,
      ),
    ).resolves.toBe(body.secret);
    expect((await request(`/assets/${asset.id}/`, undefined, shareHost, undefined)).status).toBe(
      404,
    );
    expect(
      await (await request(new URL(body.url).pathname, undefined, shareHost, undefined)).text(),
    ).toBe("secret");
    expect(
      (await request(new URL(body.url).pathname, undefined, publicHost, undefined)).status,
    ).toBe(404);
    expect(await (await request("/")).text()).toContain(body.url);
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
    const ownerArchive = await (await request("/")).text();

    expect(ownerArchive).toContain(second.url);
    expect(ownerArchive).not.toContain(first.url);
    expect(
      (await request(new URL(first.url).pathname, undefined, shareHost, undefined)).status,
    ).toBe(404);
    expect(
      (await request(new URL(second.url).pathname, undefined, shareHost, undefined)).status,
    ).toBe(200);
    expect((await request(`/api/assets/${asset.id}/secret`, { method: "DELETE" })).status).toBe(
      204,
    );
    await expect(
      env.DB.prepare("SELECT secret_hash, secret_ciphertext, secret_iv FROM assets WHERE id = ?")
        .bind(asset.id)
        .first(),
    ).resolves.toMatchObject({
      secret_hash: null,
      secret_ciphertext: null,
      secret_iv: null,
    });
    expect(
      (await request(new URL(second.url).pathname, undefined, shareHost, undefined)).status,
    ).toBe(404);
  });

  it("marks historical one-way secrets as requiring one final rotation", async () => {
    const asset = await createLiveAsset("historical secret");
    const historicalSecret = "h".repeat(43);
    await env.DB.prepare(
      "UPDATE assets SET secret_hash = ?, visibility = 'secret_link' WHERE id = ?",
    )
      .bind(await hashSecret(historicalSecret), asset.id)
      .run();

    const body = await (await request("/")).text();

    expect(body).toContain("Rotate once to recover this existing secret link");
    expect(body).not.toContain(historicalSecret);
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

    expect((await request(`/assets/${asset.id}/`, undefined, publicHost, undefined)).status).toBe(
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
      `https://${shareHost}`,
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

  it("marks no-progress uploads abandoned in a bounded scheduled pass", async () => {
    const old = "2000-01-01T00:00:00.000Z";
    const ids = Array.from({ length: 11 }, () => crypto.randomUUID());
    await env.DB.batch(
      ids.map((id, index) =>
        env.DB.prepare(
          "INSERT INTO assets (id, name, state, visibility, upload_count, upload_bytes, " +
            "finalize_token, finalize_started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(
          id,
          `Abandoned ${index}`,
          index === 0 ? "finalizing" : "uploading",
          "private",
          1,
          7,
          index === 0 ? "stale-finalize" : null,
          index === 0 ? old : null,
          old,
          old,
        ),
      ),
    );
    await env.ASSETS.put(`assets/${ids[0]}/uploads/stale`, "stale");

    await cleanupExpired(env);
    const firstPass = await env.DB.prepare(
      "SELECT state, COUNT(*) AS count FROM assets WHERE id IN (" +
        ids.map(() => "?").join(",") +
        ") GROUP BY state",
    )
      .bind(...ids)
      .all<{ state: string; count: number }>();
    expect(firstPass.results).toEqual([
      { state: "deleted", count: 10 },
      { state: "uploading", count: 1 },
    ]);
    await expect(
      env.DB.prepare("SELECT upload_count, upload_bytes, finalize_token FROM assets WHERE id = ?")
        .bind(ids[0])
        .first(),
    ).resolves.toEqual({ upload_count: 0, upload_bytes: 0, finalize_token: null });

    await cleanupExpired(env);
    await expect(
      env.DB.prepare("SELECT state FROM assets WHERE id = ?").bind(ids[10]).first(),
    ).resolves.toEqual({ state: "deleted" });
    expect((await env.ASSETS.list({ prefix: `assets/${ids[0]}/` })).objects).toHaveLength(0);
  });
});
