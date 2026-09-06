import { assetPrefix, decodePath, manifestKey, uploadKey, validateManifest } from "./artifact";
import { normalizeAssetMetadata } from "./asset-metadata";
import { assetColumns, findAsset, type AssetRow } from "./asset-store";
import type { Env } from "./environment";
import { deleteAsset } from "./cleanup";
import { assetJson, isPast } from "./privacy";
import { error, json } from "./responses";
import { readJsonWithin } from "./request";
import { maxPublicationBytes, maxUploadBytes, maxUploadFiles } from "../upload-limits";

const finalizeLeaseMilliseconds = 5 * 60 * 1000;

export async function createAsset(request: Request, env: Env): Promise<Response> {
  const id = crypto.randomUUID();
  let metadata;
  if (request.body === null) {
    metadata = { name: id.slice(0, 8), description: null };
  } else {
    let body: unknown;
    try {
      body = await readJsonWithin(request, 4 * 1024);
    } catch {
      return error("invalid_asset_metadata", 400);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return error("invalid_asset_metadata", 400);
    }
    const values = body as Record<string, unknown>;
    metadata = normalizeAssetMetadata(values.name, values.description);
    if (metadata === null) return error("invalid_asset_metadata", 400);
  }
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO assets (id, name, description, state, visibility, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, metadata.name, metadata.description, "uploading", "private", now, now)
    .run();

  return json(
    {
      asset: assetJson({
        id,
        name: metadata.name,
        description: metadata.description,
        state: "uploading",
        visibility: "private",
        upload_count: 0,
        upload_bytes: 0,
        finalize_token: null,
        finalize_started_at: null,
        manifest_id: null,
        secret_hash: null,
        secret_ciphertext: null,
        secret_iv: null,
        share_expires_at: null,
        hard_expires_at: null,
        cleanup_pending: 0,
        cleanup_checked_at: null,
        created_at: now,
        updated_at: now,
      } as AssetRow),
    },
    201,
  );
}

export async function listAssets(request: Request, env: Env): Promise<Response> {
  const offset = Number(new URL(request.url).searchParams.get("offset") ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0) return error("invalid_offset", 400);
  const { results } = await env.DB.prepare(
    `SELECT ${assetColumns} FROM assets ` +
      "WHERE state = 'live' AND (hard_expires_at IS NULL OR hard_expires_at > ?) " +
      "ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
  )
    .bind(new Date().toISOString(), 100, offset)
    .all<AssetRow>();
  return json({
    assets: results.map(assetJson),
    nextOffset: results.length === 100 ? offset + 100 : null,
  });
}

export async function inspectAsset(env: Env, id: string): Promise<Response> {
  const asset = await findAsset(env.DB, id);
  if (asset === null || asset.state === "deleted") return error("not_found", 404);
  if (isPast(asset.hard_expires_at)) {
    await deleteAsset(env, id);
    return error("not_found", 404);
  }
  return json({ asset: assetJson(asset) });
}

export async function uploadFile(
  request: Request,
  env: Env,
  id: string,
  encodedPath: string,
): Promise<Response> {
  const path = decodePath(encodedPath);
  const fileKind = request.headers.get("x-shlook-file-kind");
  if (path === null || (fileKind !== null && fileKind !== "file")) {
    return error("invalid_file", 400);
  }

  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader === null || !/^\d+$/.test(contentLengthHeader)) {
    return error("content_length_required", 411);
  }
  if (BigInt(contentLengthHeader) > BigInt(maxUploadBytes)) {
    return error("upload_file_too_large", 413);
  }
  const declaredBytes = Number(contentLengthHeader);
  const uploadId = crypto.randomUUID();
  const key = uploadKey(id, uploadId);

  const reservation = await env.DB.prepare(
    "UPDATE assets SET upload_count = upload_count + 1, upload_bytes = upload_bytes + ?, updated_at = ? " +
      "WHERE id = ? AND state = 'uploading' AND upload_count < ? AND upload_bytes + ? <= ?",
  )
    .bind(
      declaredBytes,
      new Date().toISOString(),
      id,
      maxUploadFiles,
      declaredBytes,
      maxPublicationBytes,
    )
    .run();
  if (reservation.meta.changes !== 1) {
    const asset = await findAsset(env.DB, id);
    if (asset === null || asset.state === "deleted") return error("not_found", 404);
    if (asset.state !== "uploading") return error("asset_not_uploading", 409);
    if (asset.upload_count >= maxUploadFiles) return error("upload_limit_reached", 409);
    if (asset.upload_bytes + declaredBytes > maxPublicationBytes) {
      return error("upload_bytes_limit_reached", 409);
    }
    return error("upload_limit_reached", 409);
  }

  let stored: R2Object | null;
  try {
    stored = await env.ASSETS.put(key, request.body, {
      httpMetadata: {
        contentType: request.headers.get("content-type") ?? "application/octet-stream",
      },
      customMetadata: { kind: "file", path },
    });
  } catch (cause) {
    await rollbackUpload(env, id, key, declaredBytes);
    throw cause;
  }
  if (stored === null || typeof stored !== "object") {
    await rollbackUpload(env, id, key, declaredBytes);
    return error("upload_failed", 502);
  }
  let storedSize: number;
  try {
    storedSize = stored.size;
  } catch (cause) {
    await rollbackUpload(env, id, key, declaredBytes);
    throw cause;
  }
  if (storedSize !== declaredBytes) {
    await rollbackUpload(env, id, key, declaredBytes);
    return error("upload_size_mismatch", 502);
  }

  let current: AssetRow | null;
  try {
    current = await findAsset(env.DB, id);
  } catch (cause) {
    await rollbackUpload(env, id, key, declaredBytes);
    throw cause;
  }
  if (current?.state !== "uploading") {
    await rollbackUpload(env, id, key, declaredBytes);
    return error(
      current === null || current.state === "deleted" ? "not_found" : "asset_not_uploading",
      current === null || current.state === "deleted" ? 404 : 409,
    );
  }
  return json({ file: { path, uploadId } }, 201);
}

async function releaseUploadSlot(env: Env, id: string, declaredBytes: number): Promise<void> {
  await env.DB.prepare(
    "UPDATE assets SET upload_count = MAX(upload_count - 1, 0), " +
      "upload_bytes = MAX(upload_bytes - ?, 0), updated_at = ? WHERE id = ?",
  )
    .bind(declaredBytes, new Date().toISOString(), id)
    .run();
}

async function rollbackUpload(
  env: Env,
  id: string,
  key: string,
  declaredBytes: number,
): Promise<void> {
  try {
    await env.ASSETS.delete(key);
  } catch {
    // Preserve the original upload or state error.
  }
  try {
    await releaseUploadSlot(env, id, declaredBytes);
  } catch {
    // Preserve the original upload or state error.
  }
}

export async function finalizeAsset(request: Request, env: Env, id: string): Promise<Response> {
  const asset = await findAsset(env.DB, id);
  if (asset === null || asset.state === "deleted") return error("not_found", 404);

  let value: unknown;
  try {
    value = await readJsonWithin(request, 1024 * 1024);
  } catch {
    return error("invalid_manifest", 400);
  }

  const manifest = validateManifest(value);
  if (manifest === null) return error("invalid_manifest", 400);

  const finalizeToken = crypto.randomUUID();
  const now = new Date();
  const claim = await env.DB.prepare(
    "UPDATE assets SET state = 'finalizing', finalize_token = ?, finalize_started_at = ?, updated_at = ? " +
      "WHERE id = ? AND (state = 'uploading' OR (state = 'finalizing' AND finalize_started_at < ?))",
  )
    .bind(
      finalizeToken,
      now.toISOString(),
      now.toISOString(),
      id,
      new Date(now.getTime() - finalizeLeaseMilliseconds).toISOString(),
    )
    .run();
  if (claim.meta.changes !== 1) return error("asset_not_uploading", 409);

  try {
    const uploads = new Map<string, R2Object>();
    let cursor: string | undefined;
    do {
      const page = await env.ASSETS.list({
        prefix: `${assetPrefix(id)}uploads/`,
        cursor,
        include: ["customMetadata"],
      });
      for (const object of page.objects) uploads.set(object.key, object);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor !== undefined);

    const complete = manifest.files.every((file) => {
      const object = uploads.get(uploadKey(id, file.uploadId));
      return object?.customMetadata?.kind === "file" && object.customMetadata.path === file.path;
    });
    if (!complete) {
      await env.DB.prepare(
        "UPDATE assets SET state = 'uploading', finalize_token = NULL, finalize_started_at = NULL, " +
          "updated_at = ? WHERE id = ? AND state = 'finalizing' AND finalize_token = ?",
      )
        .bind(new Date().toISOString(), id, finalizeToken)
        .run();
      return error("upload_incomplete", 409);
    }

    await env.ASSETS.put(manifestKey(id, finalizeToken), JSON.stringify(manifest), {
      httpMetadata: { contentType: "application/json" },
    });

    const completedAt = new Date().toISOString();
    const result = await env.DB.prepare(
      "UPDATE assets SET state = 'live', manifest_id = ?, finalize_token = NULL, " +
        "finalize_started_at = NULL, updated_at = ? " +
        "WHERE id = ? AND state = 'finalizing' AND finalize_token = ?",
    )
      .bind(finalizeToken, completedAt, id, finalizeToken)
      .run();
    if (result.meta.changes !== 1) {
      await env.ASSETS.delete(manifestKey(id, finalizeToken));
      return error("asset_not_uploading", 409);
    }
    return json({ asset: assetJson({ ...asset, state: "live", updated_at: completedAt }) });
  } catch (cause) {
    await env.DB.prepare(
      "UPDATE assets SET state = 'uploading', finalize_token = NULL, finalize_started_at = NULL, " +
        "updated_at = ? WHERE id = ? AND state = 'finalizing' AND finalize_token = ?",
    )
      .bind(new Date().toISOString(), id, finalizeToken)
      .run()
      .catch(() => undefined);
    throw cause;
  }
}
