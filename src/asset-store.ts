export interface AssetRow {
  id: string;
  name: string;
  description: string | null;
  state: "uploading" | "finalizing" | "live" | "deleted";
  visibility: "private" | "secret_link" | "public";
  upload_count: number;
  finalize_token: string | null;
  finalize_started_at: string | null;
  manifest_id: string | null;
  secret_hash: string | null;
  secret_ciphertext: string | null;
  secret_iv: string | null;
  share_expires_at: string | null;
  hard_expires_at: string | null;
  cleanup_pending: number;
  cleanup_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

export const assetColumns =
  "id, name, description, state, visibility, upload_count, finalize_token, finalize_started_at, manifest_id, " +
  "secret_hash, secret_ciphertext, secret_iv, share_expires_at, hard_expires_at, cleanup_pending, cleanup_checked_at, " +
  "created_at, updated_at";

export async function findAsset(db: D1Database, id: string): Promise<AssetRow | null> {
  return db.prepare(`SELECT ${assetColumns} FROM assets WHERE id = ?`).bind(id).first<AssetRow>();
}

export async function latestAsset(db: D1Database): Promise<AssetRow | null> {
  return db
    .prepare(
      `SELECT ${assetColumns} FROM assets ` +
        "WHERE state = 'live' AND (hard_expires_at IS NULL OR hard_expires_at > ?) " +
        "ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .bind(new Date().toISOString())
    .first<AssetRow>();
}
