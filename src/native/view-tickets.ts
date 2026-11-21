import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { NativeStore, Role } from "./store.ts";
import { capSessionExpiry, tokenExpiryActive } from "./token-expiry.ts";
import { sanitizeReturnPath } from "./login-redirect.ts";

/**
 * View tickets let a trusted server (such as a dashboard holding a viewer token) hand one
 * artifact to a browser that has no shlook session. A ticket is single-use, short-lived and
 * bound to one artifact. Redeeming it sets a viewer grant cookie scoped to that artifact's
 * path. See docs/view-tickets.md for the threat model.
 */
export const VIEW_TICKET_TTL_MS = 5 * 60 * 1000;
export const VIEW_GRANT_TTL_MS = 60 * 60 * 1000;
export const MAX_OUTSTANDING_TICKETS = 256;
export const TICKET_PARAM = "shlook_ticket";
export const GRANT_COOKIE = "__Secure-shlook_view";
const TICKET = /^shlook_vt_v1_[A-Za-z0-9_-]{43}$/;
const GRANT = /^[A-Za-z0-9_-]{43}$/;
const ASSET_PATH = /^\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//;

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export type GrantIdentity = {
  user: { id: string; displayName: string };
  role: Role;
  tokenId: string;
};

export class ViewTicketError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function decodedKey(part: string) {
  const key = part.split("=", 1)[0]!.replace(/\+/g, " ");
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}
/** Splits a raw request target into path, the ticket values and the query without them. */
export function splitTicket(target: string) {
  const at = target.indexOf("?");
  const path = at < 0 ? target : target.slice(0, at);
  const query = at < 0 ? "" : target.slice(at + 1);
  const kept: string[] = [],
    tickets: string[] = [];
  for (const part of query ? query.split("&") : []) {
    if (decodedKey(part) === TICKET_PARAM) tickets.push(part.slice(part.indexOf("=") + 1));
    else kept.push(part);
  }
  return { path, tickets, clean: kept.length ? `${path}?${kept.join("&")}` : path };
}
export function assetIdOf(path: string) {
  return ASSET_PATH.exec(path)?.[1] ?? null;
}

/** Validates a requested artifact view path; returns its asset ID. */
export function viewPathAsset(value: unknown): string {
  if (typeof value !== "string" || sanitizeReturnPath(value) !== value)
    throw new ViewTicketError(400, "invalid_path");
  const { path, tickets } = splitTicket(value);
  const id = assetIdOf(path);
  if (!id || tickets.length) throw new ViewTicketError(400, "invalid_path");
  return id;
}

function activeToken(store: NativeStore, tokenId: string, now: number) {
  const row = store.db
    .prepare(
      "SELECT t.id AS tokenId,t.role,t.expires_at AS expiresAt,t.revoked_at AS revokedAt,u.id AS userId,u.display_name AS displayName,u.disabled FROM tokens t JOIN users u ON u.id=t.user_id WHERE t.id=?",
    )
    .get(tokenId) as any;
  if (
    !row ||
    row.revokedAt ||
    row.disabled ||
    !["viewer", "publisher"].includes(row.role) ||
    !tokenExpiryActive(row.expiresAt, now)
  )
    return null;
  return row as {
    tokenId: string;
    role: Role;
    expiresAt: number;
    userId: string;
    displayName: string;
  };
}
function assetLive(store: NativeStore, id: string, now: number) {
  const row = store.db
    .prepare("SELECT state,hard_expires_at AS hardExpiresAt FROM assets WHERE id=?")
    .get(id) as { state: string; hardExpiresAt: number | null } | undefined;
  return Boolean(
    row && row.state === "live" && (row.hardExpiresAt === null || row.hardExpiresAt > now),
  );
}

export function issueViewTicket(
  store: NativeStore,
  tokenId: string,
  path: unknown,
  now = Date.now(),
) {
  const assetId = viewPathAsset(path);
  const token = activeToken(store, tokenId, now);
  if (!token) throw new ViewTicketError(401, "unauthorized");
  if (!assetLive(store, assetId, now)) throw new ViewTicketError(404, "not_found");
  store.db.exec("BEGIN IMMEDIATE");
  try {
    store.db.prepare("DELETE FROM view_tickets WHERE expires_at<=?").run(now);
    const outstanding = store.db
      .prepare("SELECT COUNT(*) AS count FROM view_tickets WHERE token_id=?")
      .get(tokenId) as { count: number };
    if (outstanding.count >= MAX_OUTSTANDING_TICKETS)
      throw new ViewTicketError(429, "too_many_tickets");
    const ticket = `shlook_vt_v1_${randomBytes(32).toString("base64url")}`;
    const expiresAt = capSessionExpiry(now + VIEW_TICKET_TTL_MS, token.expiresAt);
    store.db
      .prepare(
        "INSERT INTO view_tickets(ticket_hash,asset_id,token_id,user_id,created_at,expires_at) VALUES(?,?,?,?,?,?)",
      )
      .run(hash(ticket), assetId, tokenId, token.userId, now, expiresAt);
    store.db.exec("COMMIT");
    return { ticket, assetId, expiresAt };
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Redeems a ticket for one artifact. The ticket row is deleted first, whatever the outcome,
 * so a ticket can never be presented twice. Returns the new grant or null.
 */
export function redeemViewTicket(
  store: NativeStore,
  ticket: string,
  assetId: string,
  now = Date.now(),
) {
  if (!TICKET.test(ticket)) return null;
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const row = store.db
      .prepare(
        "DELETE FROM view_tickets WHERE ticket_hash=? RETURNING asset_id AS assetId,token_id AS tokenId,expires_at AS expiresAt",
      )
      .get(hash(ticket)) as { assetId: string; tokenId: string; expiresAt: number } | undefined;
    const token = row ? activeToken(store, row.tokenId, now) : null;
    if (
      !row ||
      !token ||
      row.expiresAt <= now ||
      row.assetId !== assetId ||
      !assetLive(store, assetId, now)
    ) {
      store.db.exec("COMMIT");
      return null;
    }
    const grant = randomBytes(32).toString("base64url");
    const expiresAt = capSessionExpiry(now + VIEW_GRANT_TTL_MS, token.expiresAt);
    store.db
      .prepare(
        "INSERT INTO view_grants(grant_hash,asset_id,token_id,user_id,created_at,expires_at) VALUES(?,?,?,?,?,?)",
      )
      .run(hash(grant), assetId, token.tokenId, token.userId, now, expiresAt);
    store.db.exec("COMMIT");
    return { grant, assetId, expiresAt };
  } catch (error) {
    try {
      store.db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

/** The single, well-formed grant cookie on a request, or undefined. */
export function requestGrant(request: IncomingMessage) {
  const cookies = (request.headers.cookie ?? "")
    .split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie.split("=", 1)[0] === GRANT_COOKIE);
  if (cookies.length !== 1) return undefined;
  const value = cookies[0]!.slice(GRANT_COOKIE.length + 1);
  return GRANT.test(value) ? value : undefined;
}

/** A grant authenticates only reads of the artifact it was issued for. */
export function authenticateGrant(
  store: NativeStore,
  grant: string,
  assetId: string,
  now = Date.now(),
): GrantIdentity | null {
  if (!GRANT.test(grant)) return null;
  const row = store.db
    .prepare(
      "SELECT asset_id AS assetId,token_id AS tokenId,expires_at AS expiresAt FROM view_grants WHERE grant_hash=?",
    )
    .get(hash(grant)) as { assetId: string; tokenId: string; expiresAt: number } | undefined;
  if (!row || row.assetId !== assetId) return null;
  if (row.expiresAt <= now) {
    store.db.prepare("DELETE FROM view_grants WHERE grant_hash=?").run(hash(grant));
    return null;
  }
  const token = activeToken(store, row.tokenId, now);
  if (!token || !assetLive(store, assetId, now)) return null;
  // A grant never carries more than read access, whatever the issuing token's role.
  return {
    user: { id: token.userId, displayName: token.displayName },
    role: "viewer",
    tokenId: token.tokenId,
  };
}

export function grantCookie(grant: string, assetId: string, expiresAt: number, now = Date.now()) {
  const maxAge = Math.max(0, Math.floor((expiresAt - now) / 1000));
  return `${GRANT_COOKIE}=${grant}; Path=/assets/${assetId}/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export function cleanupViewAccess(store: NativeStore, now = Date.now()) {
  store.db.prepare("DELETE FROM view_tickets WHERE expires_at<=?").run(now);
  store.db.prepare("DELETE FROM view_grants WHERE expires_at<=?").run(now);
}
