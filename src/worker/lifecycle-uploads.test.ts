import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import {
  createAsset,
  finalizeAsset,
  privateHost,
  request,
  uploadFile,
  uploadedFile,
} from "../test-harness";
import { maxPublicationBytes, maxUploadBytes } from "../upload-limits";
import { setupWorkerTestDatabase } from "./test-setup";

setupWorkerTestDatabase();

describe("asset publication", () => {
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
});
