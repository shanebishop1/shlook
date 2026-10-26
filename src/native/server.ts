import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import { isIP } from "node:net";
import { createHash as cryptoCreateHash } from "node:crypto";
import type { NativeConfig } from "./config.ts";
import { authenticateSession, authenticateToken, createSession, verifyCsrf } from "./auth.ts";
import type { NativeStore, Role } from "./store.ts";

type Bucket = { started: number; failures: number };
export class AuthThrottle {
  private peers = new Map<string, Bucket>();
  private inFlightPeers = new Map<string, number>();
  private inFlightTotal = 0;
  private total: Bucket = { started: 0, failures: 0 };
  private readonly peerLimit: number;
  private readonly totalLimit: number;
  private readonly windowMs: number;
  private readonly maxPeers: number;
  constructor(peerLimit = 10, totalLimit = 50, windowMs = 60000, maxPeers = 4096) {
    this.peerLimit = peerLimit;
    this.totalLimit = totalLimit;
    this.windowMs = windowMs;
    this.maxPeers = maxPeers;
  }
  allow(peer: string, now = Date.now()) {
    this.total = this.current(this.total, now);
    let bucket = this.peers.get(peer);
    if (!bucket) {
      if (this.peers.size >= this.maxPeers) this.peers.delete(this.peers.keys().next().value!);
      bucket = { started: now, failures: 0 };
    }
    bucket = this.current(bucket, now);
    this.peers.set(peer, bucket);
    return bucket.failures < this.peerLimit && this.total.failures < this.totalLimit;
  }
  reserve(peer: string, now = Date.now()) {
    if (!this.allow(peer, now)) return false;
    const active = this.inFlightPeers.get(peer) ?? 0;
    if (active >= this.peerLimit || this.inFlightTotal >= this.totalLimit) return false;
    this.inFlightPeers.set(peer, active + 1);
    this.inFlightTotal++;
    return true;
  }
  release(peer: string) {
    const active = this.inFlightPeers.get(peer) ?? 0;
    if (active <= 1) this.inFlightPeers.delete(peer);
    else this.inFlightPeers.set(peer, active - 1);
    if (this.inFlightTotal > 0) this.inFlightTotal--;
  }
  fail(peer: string, now = Date.now()) {
    this.allow(peer, now);
    this.peers.get(peer)!.failures++;
    this.total.failures++;
  }
  retryAfter(peer: string, now = Date.now()) {
    return Math.max(
      1,
      Math.ceil((this.windowMs - (now - (this.peers.get(peer)?.started ?? now))) / 1000),
    );
  }
  private current(bucket: Bucket, now: number) {
    return now - bucket.started >= this.windowMs ? { started: now, failures: 0 } : bucket;
  }
}

export type Identity = { user: { id: string; displayName: string }; role: Role; tokenId: string };
export type BoundaryResult =
  | { identity: Identity; kind: "bearer" | "cookie"; csrfToken?: string; expiresAt?: number }
  | { status: number; retryAfter?: number }
  | { kind: "public" | "login" };
type MatchedOrigin = { origin: string; secure: boolean };
function matchingOrigin(host: string | undefined, config: NativeConfig): MatchedOrigin | null {
  if (!host || /[\s,/@\\?#]/.test(host)) return null;
  const authorities = [config.origin, ...config.aliases];
  for (const allowed of authorities) {
    const parsed = new URL(allowed);
    try {
      const candidate = new URL(`${parsed.protocol}//${host}`);
      if (
        candidate.host.toLowerCase() === parsed.host.toLowerCase() &&
        candidate.username === "" &&
        candidate.password === ""
      )
        return { origin: parsed.origin, secure: parsed.protocol === "https:" };
    } catch {
      return null;
    }
  }
  return null;
}
function json(response: ServerResponse, status: number, value: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(value));
}
function sessionCookie(id: string, expiresAt: number, now = Date.now()) {
  const maxAge = Math.max(0, Math.floor((expiresAt - now) / 1000));
  return `__Host-shlook_session=${id}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Expires=${new Date(expiresAt).toUTCString()}`;
}
function routePath(request: IncomingMessage) {
  try {
    return new URL(request.url ?? "/", "http://native.invalid").pathname;
  } catch {
    return "";
  }
}
function recognizedDocumentRoute(path: string) {
  return (
    ["/", "/archive", "/login", "/latest"].includes(path) ||
    /^\/assets\/[0-9a-f-]{36}\/(?:.*)$/.test(path) ||
    /^\/preview\/assets\/[0-9a-f-]{36}\/.+$/.test(path)
  );
}
function fetchMetadataAllowed(request: IncomingMessage, path: string) {
  const site = request.headers["sec-fetch-site"],
    mode = request.headers["sec-fetch-mode"],
    dest = request.headers["sec-fetch-dest"];
  const api = path === "/health" || path.startsWith("/api/");
  if (api)
    return (!site || site === "same-origin") && (!dest || dest === "empty") && mode !== "navigate";
  const method = request.method ?? "GET";
  const navigation =
    (method === "GET" || method === "HEAD") &&
    recognizedDocumentRoute(path) &&
    request.headers.origin === undefined &&
    mode === "navigate" &&
    dest === "document";
  if (navigation) return true;
  if (mode === "navigate" && request.headers.origin === undefined && site !== "same-origin")
    return false;
  if (site && site !== "same-origin") return false;
  return true;
}
function boundary(
  request: IncomingMessage,
  store: NativeStore,
  matched: MatchedOrigin,
  throttle: AuthThrottle,
  now: number,
): BoundaryResult {
  const origin = request.headers.origin;
  if (origin === "null" || (origin !== undefined && origin !== matched.origin))
    return { status: 403 };
  const path = routePath(request);
  if (!fetchMetadataAllowed(request, path)) return { status: 403 };
  const peer = request.socket.remoteAddress ?? "unknown";
  const authorization = request.headers.authorization;
  if (authorization !== undefined) {
    if (!throttle.allow(peer, now))
      return { status: 429, retryAfter: throttle.retryAfter(peer, now) };
    const match = /^Bearer (\S+)$/.exec(authorization);
    const identity = match ? authenticateToken(store, match[1], now) : null;
    if (!identity) {
      throttle.fail(peer, now);
      return { status: 401 };
    }
    return { identity, kind: "bearer" };
  }
  if (["/login", "/", "/archive"].includes(path) && request.method === "GET")
    return { kind: "public" };
  if (path === "/api/session" && request.method === "POST") return { kind: "login" };
  const cookie = request.headers.cookie?.match(
    /(?:^|;\s*)__Host-shlook_session=([A-Za-z0-9_-]+)/,
  )?.[1];
  if (!cookie) return { status: 401 };
  if (!matched.secure) return { status: 401 };
  const session = authenticateSession(store, cookie, now);
  if (!session) return { status: 401 };
  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method ?? "GET")) {
    if (
      origin !== matched.origin ||
      !verifyCsrf(session.csrfHash, (request.headers["x-shlook-csrf"] as string) ?? "")
    )
      return { status: 403 };
  }
  return {
    identity: { user: session.user, role: session.role, tokenId: session.tokenId },
    kind: "cookie",
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt,
  };
}

export function checkRequestBoundary(
  request: IncomingMessage,
  store: NativeStore,
  config: NativeConfig,
  throttle = new AuthThrottle(),
  now = Date.now(),
): BoundaryResult {
  const matched = matchingOrigin(request.headers.host, config);
  return matched ? boundary(request, store, matched, throttle, now) : { status: 400 };
}

export function checkLoginExchange(request: IncomingMessage, config: NativeConfig): boolean {
  const matched = matchingOrigin(request.headers.host, config);
  return Boolean(matched?.secure && loginAllowed(request, matched.origin));
}

async function readJson(request: IncomingMessage, maxBytes = 8192): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > maxBytes) throw new Error("body too large");
    chunks.push(data);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function loginAllowed(request: IncomingMessage, origin: string): boolean {
  return (
    request.method === "POST" &&
    request.headers.origin === origin &&
    request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() === "application/json" &&
    request.headers["x-shlook-login"] === "1" &&
    (!request.headers["sec-fetch-site"] || request.headers["sec-fetch-site"] === "same-origin") &&
    (!request.headers["sec-fetch-dest"] || request.headers["sec-fetch-dest"] === "empty")
  );
}

export type NativeServerOptions = {
  store: NativeStore;
  config: NativeConfig;
  publicHandler?: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    boundary: BoundaryResult & { identity: Identity },
  ) => void | Promise<void>;
  throttle?: AuthThrottle;
};
export function createNativeServer(options: NativeServerOptions): Server {
  const throttle = options.throttle ?? new AuthThrottle();
  return createServer((request, response) => {
    void (async () => {
      const matched = matchingOrigin(request.headers.host, options.config);
      if (!matched) {
        json(response, 400, { error: "bad_request" });
        return;
      }
      const result = boundary(request, options.store, matched, throttle, Date.now());
      if ("status" in result) {
        if (result.retryAfter) response.setHeader("Retry-After", String(result.retryAfter));
        json(response, result.status, {
          error:
            result.status === 429
              ? "rate_limited"
              : result.status === 403
                ? "forbidden"
                : "unauthorized",
        });
        return;
      }
      if (result.kind === "cookie" && result.expiresAt) {
        const cookie = request.headers.cookie?.match(
          /(?:^|;\s*)__Host-shlook_session=([A-Za-z0-9_-]+)/,
        )?.[1];
        if (cookie) response.setHeader("Set-Cookie", sessionCookie(cookie, result.expiresAt));
      }
      if (result.kind === "login") {
        if (!matched.secure || !loginAllowed(request, matched.origin)) {
          json(response, 403, { error: "forbidden" });
          return;
        }
        const peer = request.socket.remoteAddress ?? "unknown";
        if (!throttle.reserve(peer)) {
          response.setHeader("Retry-After", String(throttle.retryAfter(peer)));
          json(response, 429, { error: "rate_limited" });
          return;
        }
        let authenticated = false;
        try {
          const body = await readJson(request);
          const token =
            typeof body === "object" && body !== null && !Array.isArray(body)
              ? (body as { token?: unknown }).token
              : undefined;
          const identity =
            typeof token === "string" ? authenticateToken(options.store, token) : null;
          if (!identity) {
            throttle.fail(peer);
            json(response, 401, { error: "unauthorized" });
            return;
          }
          authenticated = true;
          const existing = request.headers.cookie?.match(
            /(?:^|;\s*)__Host-shlook_session=([A-Za-z0-9_-]+)/,
          )?.[1];
          if (existing)
            options.store.db
              .prepare("DELETE FROM sessions WHERE session_hash=?")
              .run(hashSession(existing));
          const session = createSession(options.store, identity);
          response.setHeader("Set-Cookie", sessionCookie(session.id, session.expiresAt));
          json(response, 200, {
            user: identity.user,
            role: identity.role,
            csrfToken: session.csrfToken,
            expiresAt: session.expiresAt,
          });
        } catch (error) {
          if (!authenticated) throttle.fail(peer);
          const status = (error as { status?: number }).status === 413 ? 413 : 400;
          json(response, status, { error: status === 413 ? "limit_exceeded" : "invalid_request" });
        } finally {
          throttle.release(peer);
        }
        return;
      }
      if (result.kind === "public") {
        if (options.publicHandler) await options.publicHandler(request, response);
        else json(response, 404, { error: "not_found" });
        return;
      }
      if (
        request.method === "GET" &&
        routePath(request) === "/api/session" &&
        result.kind === "cookie"
      ) {
        json(response, 200, {
          user: result.identity.user,
          role: result.identity.role,
          csrfToken: result.csrfToken,
          expiresAt: result.expiresAt,
        });
        return;
      }
      if (
        request.method === "DELETE" &&
        routePath(request) === "/api/session" &&
        result.kind === "cookie"
      ) {
        const cookie = request.headers.cookie?.match(
          /(?:^|;\s*)__Host-shlook_session=([A-Za-z0-9_-]+)/,
        )?.[1];
        if (cookie)
          options.store.db
            .prepare("DELETE FROM sessions WHERE session_hash=?")
            .run(hashSession(cookie));
        response.setHeader(
          "Set-Cookie",
          "__Host-shlook_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
        );
        json(response, 200, { ok: true });
        return;
      }
      await options.handler(request, response, result as BoundaryResult & { identity: Identity });
    })().catch(() => {
      if (!response.headersSent) json(response, 500, { error: "internal_error" });
      else response.destroy();
    });
  });
}

function hashSession(sessionId: string) {
  return cryptoCreateHash("sha256").update(sessionId).digest("hex");
}

export function listenLoopback(server: Server, host = "127.0.0.1", port = 8789): Promise<void> {
  if (
    !isIP(host) ||
    !["127.0.0.1", "::1"].includes(host) ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535
  )
    throw new Error("server must bind to loopback");
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}
