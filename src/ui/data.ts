import { hashSecret } from "../worker/privacy";
import { decryptSecret } from "../worker/secret-crypto";
import type { OwnerAsset, OwnerAssetRow } from "./types";

export const pageSize = 24;

export async function readOwnerAssets(
  db: D1Database,
  offset: number,
  shareOrigin: string,
  secretEncryptionKey?: string,
): Promise<{ assets: OwnerAsset[]; hasMore: boolean }> {
  const { results } = await db
    .prepare(
      "SELECT id, name, description, visibility, secret_hash, secret_ciphertext, secret_iv, " +
        "share_expires_at, hard_expires_at, created_at, updated_at FROM assets WHERE state = 'live' AND " +
        "(hard_expires_at IS NULL OR hard_expires_at > ?) " +
        "ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
    )
    .bind(new Date().toISOString(), pageSize + 1, offset)
    .all<OwnerAssetRow>();

  const recovered = await Promise.all(
    results.map(async (asset): Promise<OwnerAsset> => {
      let secretUrl: string | null = null;
      if (
        asset.secret_hash !== null &&
        asset.secret_ciphertext !== null &&
        asset.secret_iv !== null &&
        secretEncryptionKey !== undefined
      ) {
        try {
          const secret = await decryptSecret(
            asset.secret_ciphertext,
            asset.secret_iv,
            asset.id,
            secretEncryptionKey,
          );
          if ((await hashSecret(secret)) === asset.secret_hash) {
            secretUrl = `${shareOrigin}/s/${secret}/assets/${asset.id}/`;
          }
        } catch {
          // A missing, rotated, or corrupt key must not expose an invalid capability.
        }
      }
      return {
        ...asset,
        has_secret: asset.secret_hash === null ? 0 : 1,
        secret_url: secretUrl,
      };
    }),
  );

  return { assets: recovered.slice(0, pageSize), hasMore: results.length > pageSize };
}
