import { assetPrefix } from "./artifact";

interface CleanupEnv {
  ASSETS: R2Bucket;
  DB: D1Database;
}

export async function cleanupAssetPage(env: CleanupEnv, id: string): Promise<void> {
  const page = await env.ASSETS.list({ prefix: assetPrefix(id), limit: 1000 });
  if (page.objects.length > 0) await env.ASSETS.delete(page.objects.map((object) => object.key));
  await env.DB.prepare("UPDATE assets SET cleanup_pending = 1, cleanup_checked_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), id)
    .run();
}

export async function deleteAsset(env: CleanupEnv, id: string): Promise<Response> {
  const asset = await env.DB.prepare("SELECT state FROM assets WHERE id = ?")
    .bind(id)
    .first<{ state: string }>();
  if (asset === null) return Response.json({ error: "not_found" }, { status: 404 });
  await env.DB.prepare(
    "UPDATE assets SET state = 'deleted', cleanup_pending = 1, finalize_token = NULL, " +
      "finalize_started_at = NULL, updated_at = ? WHERE id = ?",
  )
    .bind(new Date().toISOString(), id)
    .run();
  await cleanupAssetPage(env, id);
  return new Response(null, { status: 204 });
}

export async function cleanupExpired(env: CleanupEnv): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE assets SET state = 'deleted', cleanup_pending = 1, updated_at = ? WHERE id IN (" +
      "SELECT id FROM assets WHERE state = 'live' AND hard_expires_at IS NOT NULL " +
      "AND hard_expires_at <= ? ORDER BY hard_expires_at LIMIT 10)",
  )
    .bind(now, now)
    .run();
  const { results } = await env.DB.prepare(
    "SELECT id FROM assets WHERE cleanup_pending = 1 ORDER BY cleanup_checked_at ASC LIMIT 10",
  ).all<{ id: string }>();
  for (const row of results) {
    await env.DB.prepare("UPDATE assets SET cleanup_checked_at = ?, updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), new Date().toISOString(), row.id)
      .run();
    await cleanupAssetPage(env, row.id).catch(() => undefined);
  }
}
