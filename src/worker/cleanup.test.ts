import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { cleanupExpired } from "../cleanup";
import { handlePrivacyMutation } from "../privacy";
import { createLiveAsset, ownerHost, privateHost, request, shareHost } from "../test-harness";
import { setupWorkerTestDatabase } from "./test-setup";

setupWorkerTestDatabase();

describe("privacy and lifecycle", () => {
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
