import { readJsonWithin } from "./request";

export interface Env {
  ASSETS: R2Bucket;
  DB: D1Database;
}

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const assetIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const assetColumns =
  "id, state, visibility, upload_count, finalize_token, finalize_started_at, manifest_id, created_at, updated_at";
const maxUploads = 500;
const finalizeLeaseMilliseconds = 5 * 60 * 1000;

interface AssetRow {
  id: string;
  state: "uploading" | "finalizing" | "live" | "deleted";
  visibility: "private" | "secret_link" | "public";
  upload_count: number;
  finalize_token: string | null;
  finalize_started_at: string | null;
  manifest_id: string | null;
  created_at: string;
  updated_at: string;
}

interface Manifest {
  version: 1;
  entrypoint: string;
  files: ManifestFile[];
}

interface ManifestFile {
  path: string;
  uploadId: string;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: jsonHeaders });
}

function error(code: string, status: number): Response {
  return json({ error: code }, status);
}

function assetJson(row: AssetRow) {
  return {
    id: row.id,
    state: row.state,
    visibility: row.visibility,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function decodePath(encodedPath: string): string | null {
  try {
    return safePath(decodeURIComponent(encodedPath));
  } catch {
    return null;
  }
}

function safePath(path: string): string | null {
  if (
    path.length === 0 ||
    path.length > 1024 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    Array.from(path).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    return null;
  }

  const segments = path.split("/");
  return segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ? null
    : path;
}

function assetPrefix(id: string): string {
  return `assets/${id}/`;
}

function uploadKey(id: string, uploadId: string): string {
  return `${assetPrefix(id)}uploads/${uploadId}`;
}

function manifestKey(id: string, manifestId: string): string {
  return `${assetPrefix(id)}manifests/${manifestId}.json`;
}

async function findAsset(env: Env, id: string): Promise<AssetRow | null> {
  return env.DB.prepare(`SELECT ${assetColumns} FROM assets WHERE id = ?`)
    .bind(id)
    .first<AssetRow>();
}

async function latestAsset(env: Env): Promise<AssetRow | null> {
  return env.DB.prepare(
    `SELECT ${assetColumns} FROM assets ` +
      "WHERE state = 'live' ORDER BY created_at DESC, id DESC LIMIT 1",
  ).first<AssetRow>();
}

function validateManifest(value: unknown): Manifest | null {
  if (typeof value !== "object" || value === null) return null;

  const input = value as { entrypoint?: unknown; files?: unknown };
  if (typeof input.entrypoint !== "string" || !Array.isArray(input.files)) return null;
  if (input.files.length === 0 || input.files.length > maxUploads) return null;

  const entrypoint = safePath(input.entrypoint);
  const files = input.files.map((file): ManifestFile | null => {
    if (typeof file !== "object" || file === null) return null;
    const candidate = file as { path?: unknown; uploadId?: unknown };
    if (typeof candidate.path !== "string" || typeof candidate.uploadId !== "string") return null;
    const path = safePath(candidate.path);
    return path === null || !assetIdPattern.test(candidate.uploadId)
      ? null
      : { path, uploadId: candidate.uploadId };
  });
  if (entrypoint === null || files.some((file) => file === null)) return null;

  const validFiles = files as ManifestFile[];
  if (
    new Set(validFiles.map((file) => file.path)).size !== validFiles.length ||
    new Set(validFiles.map((file) => file.uploadId)).size !== validFiles.length ||
    !validFiles.some((file) => file.path === entrypoint)
  ) {
    return null;
  }
  return { version: 1, entrypoint, files: validFiles };
}

async function readManifest(env: Env, id: string, manifestId: string): Promise<Manifest | null> {
  const object = await env.ASSETS.get(manifestKey(id, manifestId));
  if (object === null) return null;

  try {
    return validateManifest(await object.json<unknown>());
  } catch {
    return null;
  }
}

async function createAsset(env: Env): Promise<Response> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO assets (id, state, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, "uploading", "private", now, now)
    .run();

  return json(
    {
      asset: assetJson({
        id,
        state: "uploading",
        visibility: "private",
        upload_count: 0,
        finalize_token: null,
        finalize_started_at: null,
        manifest_id: null,
        created_at: now,
        updated_at: now,
      }),
    },
    201,
  );
}

async function listAssets(request: Request, env: Env): Promise<Response> {
  const offset = Number(new URL(request.url).searchParams.get("offset") ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0) return error("invalid_offset", 400);
  const { results } = await env.DB.prepare(
    `SELECT ${assetColumns} FROM assets ` +
      "WHERE state = 'live' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
  )
    .bind(100, offset)
    .all<AssetRow>();
  return json({
    assets: results.map(assetJson),
    nextOffset: results.length === 100 ? offset + 100 : null,
  });
}

async function inspectAsset(env: Env, id: string): Promise<Response> {
  const asset = await findAsset(env, id);
  return asset === null || asset.state === "deleted"
    ? error("not_found", 404)
    : json({ asset: assetJson(asset) });
}

async function uploadFile(
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

  const reservation = await env.DB.prepare(
    "UPDATE assets SET upload_count = upload_count + 1, updated_at = ? " +
      "WHERE id = ? AND state = 'uploading' AND upload_count < ?",
  )
    .bind(new Date().toISOString(), id, maxUploads)
    .run();
  if (reservation.meta.changes !== 1) {
    const asset = await findAsset(env, id);
    if (asset === null || asset.state === "deleted") return error("not_found", 404);
    return asset.state === "uploading"
      ? error("upload_limit_reached", 409)
      : error("asset_not_uploading", 409);
  }

  const uploadId = crypto.randomUUID();
  const key = uploadKey(id, uploadId);
  await env.ASSETS.put(key, request.body, {
    httpMetadata: {
      contentType: request.headers.get("content-type") ?? "application/octet-stream",
    },
    customMetadata: { kind: "file", path },
  });

  let current: AssetRow | null;
  try {
    current = await findAsset(env, id);
  } catch (cause) {
    await env.ASSETS.delete(key).then(
      () => releaseUploadSlot(env, id),
      () => undefined,
    );
    throw cause;
  }
  if (current?.state !== "uploading") {
    await env.ASSETS.delete(key);
    await releaseUploadSlot(env, id);
    return error(
      current === null || current.state === "deleted" ? "not_found" : "asset_not_uploading",
      current === null || current.state === "deleted" ? 404 : 409,
    );
  }
  return json({ file: { path, uploadId } }, 201);
}

async function releaseUploadSlot(env: Env, id: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE assets SET upload_count = MAX(upload_count - 1, 0), updated_at = ? WHERE id = ?",
  )
    .bind(new Date().toISOString(), id)
    .run()
    .catch(() => undefined);
}

async function finalizeAsset(request: Request, env: Env, id: string): Promise<Response> {
  const asset = await findAsset(env, id);
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

async function serveAsset(env: Env, asset: AssetRow, encodedPath: string): Promise<Response> {
  if (asset.state !== "live") return error("not_found", 404);

  if (asset.manifest_id === null) return error("not_found", 404);
  const manifest = await readManifest(env, asset.id, asset.manifest_id);
  if (manifest === null) return error("not_found", 404);

  const path = encodedPath === "" ? manifest.entrypoint : decodePath(encodedPath);
  const file = manifest.files.find((candidate) => candidate.path === path);
  if (path === null || file === undefined) return error("not_found", 404);

  const object = await env.ASSETS.get(uploadKey(asset.id, file.uploadId));
  if (object === null) return error("not_found", 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(object.body, { headers });
}

async function deleteAsset(env: Env, id: string): Promise<Response> {
  const asset = await findAsset(env, id);
  if (asset === null) return error("not_found", 404);

  if (asset.state !== "deleted") {
    await env.DB.prepare(
      "UPDATE assets SET state = 'deleted', finalize_token = NULL, finalize_started_at = NULL, " +
        "updated_at = ? WHERE id = ?",
    )
      .bind(new Date().toISOString(), id)
      .run();
  }

  while (true) {
    const page = await env.ASSETS.list({ prefix: assetPrefix(id), limit: 1000 });
    if (page.objects.length === 0) break;
    await env.ASSETS.delete(page.objects.map((object) => object.key));
  }
  return new Response(null, { status: 204 });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true, service: "shlook" });
  }

  if (url.pathname === "/api/assets") {
    if (request.method === "POST") return createAsset(env);
    if (request.method === "GET") return listAssets(request, env);
  }

  const fileRoute = url.pathname.match(/^\/api\/assets\/([^/]+)\/files\/(.+)$/);
  if (request.method === "PUT" && fileRoute !== null && assetIdPattern.test(fileRoute[1])) {
    return uploadFile(request, env, fileRoute[1], fileRoute[2]);
  }

  const finalizeRoute = url.pathname.match(/^\/api\/assets\/([^/]+)\/finalize$/);
  if (
    request.method === "POST" &&
    finalizeRoute !== null &&
    assetIdPattern.test(finalizeRoute[1])
  ) {
    return finalizeAsset(request, env, finalizeRoute[1]);
  }

  const apiAssetRoute = url.pathname.match(/^\/api\/assets\/([^/]+)$/);
  if (apiAssetRoute !== null && assetIdPattern.test(apiAssetRoute[1])) {
    if (request.method === "GET") return inspectAsset(env, apiAssetRoute[1]);
    if (request.method === "DELETE") return deleteAsset(env, apiAssetRoute[1]);
  }

  const latestRoute = url.pathname.match(/^\/latest(?:\/(.*))?$/);
  if (request.method === "GET" && latestRoute !== null) {
    const asset = await latestAsset(env);
    return asset === null ? error("not_found", 404) : serveAsset(env, asset, latestRoute[1] ?? "");
  }

  const directRoute = url.pathname.match(/^\/assets\/([^/]+)(?:\/(.*))?$/);
  if (request.method === "GET" && directRoute !== null && assetIdPattern.test(directRoute[1])) {
    const asset = await findAsset(env, directRoute[1]);
    return asset === null ? error("not_found", 404) : serveAsset(env, asset, directRoute[2] ?? "");
  }

  return error("not_found", 404);
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  try {
    return await route(request, env);
  } catch {
    return error("internal_error", 500);
  }
}

export default { fetch: handleRequest } satisfies ExportedHandler<Env>;
