import { type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { NativeApiError, NativeAssetService, decodeAssetPath } from "./api.ts";
import { deliverArtifact, entrypointLocation } from "./delivery.ts";
import {
  createNativeServer,
  type AuthorizedBoundary,
  type Identity,
  type NativeServerOptions,
  revalidateAuthorizedRequest,
} from "./server.ts";
import type { NativeConfig } from "./config.ts";
import type { NativeStore } from "./store.ts";

const JSON_LIMIT = 1024 * 1024;
function json(response: ServerResponse, status: number, value: unknown) {
  if (response.headersSent) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(value));
}
async function bodyJson(request: IncomingMessage): Promise<unknown> {
  const declared = request.headers["content-length"];
  if (
    declared !== undefined &&
    (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > JSON_LIMIT)
  )
    throw new NativeApiError(413, "limit_exceeded");
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > JSON_LIMIT) throw new NativeApiError(413, "limit_exceeded");
    parts.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw new NativeApiError(400, "invalid_json");
  }
}
function apiResponse(response: ServerResponse, status: number, value: unknown) {
  json(response, status, value);
}
function parts(url: string | undefined) {
  try {
    return new URL(url ?? "/", "http://native.invalid");
  } catch {
    return null;
  }
}
function fail(response: ServerResponse, error: unknown) {
  if (error instanceof NativeApiError) json(response, error.status, { error: error.code });
  else json(response, 500, { error: "internal_error" });
}
function requireViewer(identity: Identity) {
  if (identity.role !== "viewer" && identity.role !== "publisher")
    throw new NativeApiError(403, "forbidden");
}
function requirePublisher(identity: Identity) {
  if (identity.role !== "publisher") throw new NativeApiError(403, "forbidden");
}
function freshAuthorizationGuard(
  request: IncomingMessage,
  store: NativeStore,
  config: NativeConfig,
  auth: AuthorizedBoundary,
) {
  return () => {
    if (
      (auth.kind !== "cookie" && auth.kind !== "bearer") ||
      !revalidateAuthorizedRequest(request, store, config, auth)
    )
      throw new NativeApiError(401, "unauthorized");
  };
}
function queryOffset(url: URL) {
  const value = url.searchParams.get("offset") ?? "0";
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new NativeApiError(400, "invalid_offset");
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new NativeApiError(400, "invalid_offset");
  return number;
}

export type NativeApplicationOptions = {
  store: NativeStore;
  config: NativeConfig;
  loginHandler?: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
  ownerHandler?: (
    request: IncomingMessage,
    response: ServerResponse,
    context: { user: Identity["user"]; role: Identity["role"] },
  ) => void | Promise<void>;
  throttle?: NativeServerOptions["throttle"];
};
export type NativeApplication = {
  server: Server;
  assets: NativeAssetService;
  cleanup: () => { cleaned: number; failures: number };
  dispose: () => void;
};

/** Builds the authenticated asset API/delivery server. Call close() on server then dispose(). */
export function createNativeApplication(options: NativeApplicationOptions): NativeApplication {
  const assets = new NativeAssetService(options.store);
  const handler = async (
    request: IncomingMessage,
    response: ServerResponse,
    auth: AuthorizedBoundary,
  ) => {
    const url = parts(request.url);
    if (!url) {
      json(response, 400, { error: "bad_request" });
      return;
    }
    const path = url.pathname,
      method = request.method ?? "GET",
      identity = auth.identity;
    try {
      const assertFreshAuthorization = freshAuthorizationGuard(
        request,
        options.store,
        options.config,
        auth,
      );
      if (
        (method === "GET" || method === "HEAD") &&
        (path === "/" || path === "/archive" || path.startsWith("/ui/"))
      ) {
        if (options.ownerHandler) {
          await options.ownerHandler(request, response, {
            user: identity.user,
            role: identity.role,
          });
          return;
        }
      }
      if (method === "GET" && path === "/health") {
        requireViewer(identity);
        apiResponse(response, 200, { ok: true, service: "shlook" });
        return;
      }
      if (method === "GET" && path === "/api/me") {
        requireViewer(identity);
        apiResponse(response, 200, {
          backend: "native",
          user: identity.user,
          role: identity.role,
          capabilities:
            identity.role === "publisher" ? ["read", "publish", "delete", "expiry"] : ["read"],
        });
        return;
      }
      if (path === "/api/assets" && method === "GET") {
        requireViewer(identity);
        apiResponse(response, 200, assets.list(queryOffset(url)));
        return;
      }
      if (path === "/api/assets" && method === "POST") {
        requirePublisher(identity);
        const input = await bodyJson(request);
        assertFreshAuthorization();
        apiResponse(response, 201, {
          asset: assets.create(input, identity, assertFreshAuthorization),
        });
        return;
      }
      const assetRoute = /^\/api\/assets\/([^/]+)(?:\/(.*))?$/.exec(path);
      if (assetRoute) {
        const id = assetRoute[1]!,
          rest = assetRoute[2] ?? "";
        if (method === "GET" && !rest) {
          requireViewer(identity);
          apiResponse(response, 200, { asset: assets.get(id) });
          return;
        }
        if (method === "PUT" && rest.startsWith("files/")) {
          requirePublisher(identity);
          const encoded = rest.slice("files/".length);
          const filePath = decodeAssetPath(encoded);
          const revalidateUpload = freshAuthorizationGuard(
            request,
            options.store,
            options.config,
            auth,
          );
          const file = await assets.upload(
            id,
            filePath,
            request,
            request.headers["content-length"],
            revalidateUpload,
          );
          apiResponse(response, 201, { file });
          return;
        }
        if (method === "POST" && rest === "finalize") {
          requirePublisher(identity);
          const input = await bodyJson(request);
          assertFreshAuthorization();
          apiResponse(response, 200, {
            asset: assets.finalize(id, input, assertFreshAuthorization),
          });
          return;
        }
        if (method === "DELETE" && !rest) {
          requirePublisher(identity);
          assertFreshAuthorization();
          assets.delete(id, assertFreshAuthorization);
          response.statusCode = 204;
          response.end();
          return;
        }
        if (method === "PATCH" && rest === "expiry") {
          requirePublisher(identity);
          const input = await bodyJson(request);
          assertFreshAuthorization();
          apiResponse(response, 200, {
            asset: assets.setExpiry(id, input, assertFreshAuthorization),
          });
          return;
        }
        if (method === "PATCH" && rest === "visibility") {
          requirePublisher(identity);
          const input = await bodyJson(request);
          assertFreshAuthorization();
          apiResponse(response, 200, {
            asset: assets.setVisibility(id, input, assertFreshAuthorization),
          });
          return;
        }
        if (/^(?:secret|share)(?:\/|$)/.test(rest))
          throw new NativeApiError(400, "unsupported_operation");
      }
      const redirect = /^\/assets\/([0-9a-f-]{36})\/(?:|latest)$/.exec(path);
      if ((method === "GET" || method === "HEAD") && redirect) {
        requireViewer(identity);
        response.statusCode = 302;
        response.setHeader("Location", entrypointLocation(assets, redirect[1]!));
        response.setHeader("Cache-Control", "private, no-store");
        response.end();
        return;
      }
      const artifact = /^\/(?:assets|preview\/assets)\/([0-9a-f-]{36})\/(.+)$/.exec(path);
      if ((method === "GET" || method === "HEAD") && artifact) {
        requireViewer(identity);
        const relative = decodeAssetPath(artifact[2]!);
        deliverArtifact(
          response,
          assets,
          artifact[1]!,
          relative,
          path.startsWith("/preview/"),
          method === "HEAD",
        );
        return;
      }
      if (path.startsWith("/api/assets/") && /(?:visibility|expiry|secret|share)/.test(path))
        throw new NativeApiError(400, "unsupported_operation");
      throw new NativeApiError(404, "not_found");
    } catch (error) {
      fail(response, error);
    }
  };
  const publicHandler = async (request: IncomingMessage, response: ServerResponse) => {
    const url = parts(request.url),
      path = url?.pathname;
    if (path === "/" || path === "/archive") {
      response.statusCode = 302;
      response.setHeader("Location", `/login?return=${encodeURIComponent(path)}`);
      response.setHeader("Cache-Control", "private, no-store");
      response.end();
      return;
    }
    if (
      (path === "/login" || path === "/ui/app.js" || path === "/ui/style.css") &&
      options.loginHandler
    ) {
      await options.loginHandler(request, response);
      return;
    }
    json(response, 404, { error: "not_found" });
  };
  const server = createNativeServer({
    store: options.store,
    config: options.config,
    handler,
    publicHandler,
    throttle: options.throttle,
  });
  const cleanup = () => assets.cleanup();
  try {
    assets.cleanup(Date.now(), options.store.ownsServerLock);
  } catch {
    /* retry through explicit/hourly cleanup */
  }
  const timer = setInterval(
    () => {
      try {
        cleanup();
      } catch {
        /* leave state for retry */
      }
    },
    60 * 60 * 1000,
  );
  timer.unref();
  return { server, assets, cleanup, dispose: () => clearInterval(timer) };
}
