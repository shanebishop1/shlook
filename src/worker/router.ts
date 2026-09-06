import { assetIdPattern } from "./artifact";
import { inspectAsset, listAssets, createAsset, uploadFile, finalizeAsset } from "./owner-api";
import { findAsset, latestAsset } from "./asset-store";
import { cleanupAssetPage, deleteAsset } from "./cleanup";
import type { Env } from "./environment";
import { ownerFavicon, ownerPage } from "./owner-ui";
import { deploymentConfig, handlePrivacyMutation, hasOwnerAccess, isPast } from "./privacy";
import { error, json } from "./responses";
import { serveWithPolicy } from "./artifact-delivery";

async function route(
  request: Request,
  env: Env,
  ctx?: Pick<ExecutionContext, "access">,
): Promise<Response> {
  const url = new URL(request.url);
  const config = deploymentConfig(env);
  const requestOrigin = url.origin;

  // Keep the origin allowlist explicit: origin determines which surface may handle a request.
  if (
    ![config.ownerOrigin, config.privateOrigin, config.publicOrigin, config.shareOrigin].includes(
      requestOrigin,
    )
  ) {
    return error("not_found", 404);
  }

  // Only the public and share origins are intentionally unauthenticated.
  if (
    requestOrigin !== config.publicOrigin &&
    requestOrigin !== config.shareOrigin &&
    !(await hasOwnerAccess(config.ownerEmail, ctx))
  ) {
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

  if (requestOrigin === config.publicOrigin) {
    const direct = url.pathname.match(/^\/assets\/([^/]+)(?:\/(.*))?$/);
    if (request.method === "GET" && direct !== null && assetIdPattern.test(direct[1]))
      return serveWithPolicy(env, await findAsset(env.DB, direct[1]), direct[2] ?? "", "public");
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
    return error("not_found", 404);
  }

  // The owner origin is the only mutation surface. Keep this CSRF boundary visible here.
  if (
    !["GET", "HEAD"].includes(request.method) &&
    request.headers.get("origin") !== config.ownerOrigin &&
    request.headers.get("x-shlook-client") !== "1"
  ) {
    return error("csrf_denied", 403);
  }

  const fetchDestination = request.headers.get("sec-fetch-dest");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    url.pathname.startsWith("/api/") &&
    ((fetchDestination !== null && fetchDestination !== "empty") ||
      (fetchSite !== null && fetchSite !== "same-origin"))
  ) {
    return error("request_denied", 403);
  }

  if (request.method === "GET" && url.pathname === "/favicon.svg") return ownerFavicon();

  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true, service: "shlook" });
  }

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/archive")) {
    return ownerPage(
      request,
      env.DB,
      config.privateOrigin,
      config.publicOrigin,
      config.shareOrigin,
      env.SHLOOK_SECRET_ENCRYPTION_KEY,
    );
  }

  const preview = url.pathname.match(/^\/preview\/assets\/([^/]+)(?:\/(.*))?$/);
  if (request.method === "GET" && preview !== null && assetIdPattern.test(preview[1])) {
    return serveWithPolicy(
      env,
      await findAsset(env.DB, preview[1]),
      preview[2] ?? "",
      "private",
      undefined,
      true,
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
