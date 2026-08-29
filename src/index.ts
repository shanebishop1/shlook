import {
  assetIdPattern,
  assetPrefix,
  artifactHeaders,
  decodePath,
  manifestKey,
  readManifest,
  uploadKey,
  validateManifest,
} from "./artifact";
import { normalizeAssetMetadata } from "./asset-metadata";
import { assetColumns, findAsset, latestAsset, type AssetRow } from "./asset-store";
import { cleanupAssetPage, cleanupExpired, deleteAsset } from "./cleanup";
import { ownerPage } from "./owner-ui";
import {
  artifactAccess,
  assetJson,
  deploymentConfig,
  handlePrivacyMutation,
  hasOwnerAccess,
  isPast,
  type DeploymentEnv,
} from "./privacy";
import { readJsonWithin } from "./request";

export interface Env extends DeploymentEnv {
  ASSETS: R2Bucket;
  DB: D1Database;
}

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const maxUploads = 500;
const finalizeLeaseMilliseconds = 5 * 60 * 1000;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: jsonHeaders });
}

function error(code: string, status: number): Response {
  return json({ error: code }, status);
}

async function createAsset(request: Request, env: Env): Promise<Response> {
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

async function listAssets(request: Request, env: Env): Promise<Response> {
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

async function inspectAsset(env: Env, id: string): Promise<Response> {
  const asset = await findAsset(env.DB, id);
  if (asset === null || asset.state === "deleted") return error("not_found", 404);
  if (isPast(asset.hard_expires_at)) {
    await deleteAsset(env, id);
    return error("not_found", 404);
  }
  return json({ asset: assetJson(asset) });
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
    const asset = await findAsset(env.DB, id);
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
    current = await findAsset(env.DB, id);
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

async function serveAsset(env: Env, asset: AssetRow, encodedPath: string): Promise<Response> {
  if (asset.state !== "live") return error("not_found", 404);

  if (asset.manifest_id === null) return error("not_found", 404);
  const manifest = await readManifest(env.ASSETS, asset.id, asset.manifest_id);
  if (manifest === null) return error("not_found", 404);

  const path = encodedPath === "" ? manifest.entrypoint : decodePath(encodedPath);
  const file = manifest.files.find((candidate) => candidate.path === path);
  if (path === null || file === undefined) return error("not_found", 404);

  const object = await env.ASSETS.get(uploadKey(asset.id, file.uploadId));
  if (object === null) return error("not_found", 404);

  return new Response(object.body, { headers: artifactHeaders(object) });
}

async function serveWithPolicy(
  env: Env,
  asset: AssetRow | null,
  path: string,
  mode: "private" | "public" | "secret",
  secret?: string,
): Promise<Response> {
  if (asset === null || asset.state !== "live") return error("not_found", 404);
  const access = await artifactAccess(asset, mode, secret);
  if (access === "hard_expired") {
    await deleteAsset(env, asset.id);
    return error("not_found", 404);
  }
  return access === "allow" ? serveAsset(env, asset, path) : error("not_found", 404);
}

async function route(
  request: Request,
  env: Env,
  ctx?: Pick<ExecutionContext, "access">,
): Promise<Response> {
  const url = new URL(request.url);
  const config = deploymentConfig(env);
  const requestOrigin = url.origin;
  if (![config.ownerOrigin, config.privateOrigin, config.shareOrigin].includes(requestOrigin)) {
    return error("not_found", 404);
  }
  if (requestOrigin !== config.shareOrigin && !(await hasOwnerAccess(config.ownerEmail, ctx))) {
    return error("access_required", 403);
  }

  if (requestOrigin === config.privateOrigin) {
    const latest = url.pathname.match(/^\/latest(?:\/(.*))?$/);
    if (request.method === "GET" && latest !== null)
      return serveWithPolicy(env, await latestAsset(env.DB), latest[1] ?? "", "private");
    const direct = url.pathname.match(/^\/assets\/([^/]+)(?:\/(.*))?$/);
    if (request.method === "GET" && direct !== null && assetIdPattern.test(direct[1]))
      return serveWithPolicy(env, await findAsset(env.DB, direct[1]), direct[2] ?? "", "private");
    return error("not_found", 404);
  }

  if (requestOrigin === config.shareOrigin) {
    const secret = url.pathname.match(/^\/s\/([^/]+)\/assets\/([^/]+)(?:\/(.*))?$/);
    if (
      request.method === "GET" &&
      secret !== null &&
      /^[A-Za-z0-9_-]{43}$/.test(secret[1]) &&
      assetIdPattern.test(secret[2])
    )
      return serveWithPolicy(
        env,
        await findAsset(env.DB, secret[2]),
        secret[3] ?? "",
        "secret",
        secret[1],
      );
    const direct = url.pathname.match(/^\/assets\/([^/]+)(?:\/(.*))?$/);
    if (request.method === "GET" && direct !== null && assetIdPattern.test(direct[1]))
      return serveWithPolicy(env, await findAsset(env.DB, direct[1]), direct[2] ?? "", "public");
    return error("not_found", 404);
  }

  if (
    !["GET", "HEAD"].includes(request.method) &&
    request.headers.get("origin") !== config.ownerOrigin &&
    request.headers.get("x-shlook-client") !== "1"
  ) {
    return error("csrf_denied", 403);
  }

  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true, service: "shlook" });
  }

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/archive")) {
    return ownerPage(
      request,
      env.DB,
      config.privateOrigin,
      config.shareOrigin,
      env.SHLOOK_SECRET_ENCRYPTION_KEY,
    );
  }

  if (url.pathname === "/api/assets") {
    if (request.method === "POST") return createAsset(request, env);
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

  const privacyRoute = url.pathname.match(/^\/api\/assets\/([^/]+)\/(visibility|secret|expiry)$/);
  if (privacyRoute !== null && assetIdPattern.test(privacyRoute[1])) {
    const asset = await findAsset(env.DB, privacyRoute[1]);
    if (asset === null || asset.state === "deleted") return error("not_found", 404);
    if (isPast(asset.hard_expires_at)) {
      await deleteAsset(env, asset.id);
      return error("not_found", 404);
    }
    const response = await handlePrivacyMutation(
      request,
      env.DB,
      asset,
      privacyRoute[2] as "visibility" | "secret" | "expiry",
      config.shareOrigin,
      env.SHLOOK_SECRET_ENCRYPTION_KEY,
    );
    if (response !== null) {
      if (privacyRoute[2] === "expiry" && response.ok) {
        const updated = await findAsset(env.DB, asset.id);
        if (updated !== null && isPast(updated.hard_expires_at)) await deleteAsset(env, asset.id);
        else if (updated?.cleanup_pending === 1) await cleanupAssetPage(env, asset.id);
      }
      return response;
    }
  }

  if (request.method === "GET" && /^\/(latest|assets\/)/.test(url.pathname)) {
    return Response.redirect(`${config.privateOrigin}${url.pathname}${url.search}`, 302);
  }

  return error("not_found", 404);
}

export async function handleRequest(
  request: Request,
  env: Env,
  ctx?: Pick<ExecutionContext, "access">,
): Promise<Response> {
  try {
    return await route(request, env, ctx);
  } catch {
    return error("internal_error", 500);
  }
}

export { cleanupExpired } from "./cleanup";

export default {
  fetch: handleRequest,
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(cleanupExpired(env));
  },
} satisfies ExportedHandler<Env>;
