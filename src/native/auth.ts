import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NativeStore, Role } from "./store.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const NATIVE_SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
export const NATIVE_SESSION_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;
const csrfFor = (sessionId: string) =>
  createHmac("sha256", sessionId).update("shlook csrf v1").digest("base64url");
const equalHex = (a: string, b: string) => {
  const aa = Buffer.from(a, "hex"),
    bb = Buffer.from(b, "hex");
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};
export type Identity = { user: { id: string; displayName: string }; role: Role; tokenId: string };

export function authenticateToken(
  store: NativeStore,
  secret: string,
  now = Date.now(),
): Identity | null {
  if (
    typeof secret !== "string" ||
    secret.length > 100 ||
    !/^shlook_api_v1_[A-Za-z0-9_-]{43}$/.test(secret)
  )
    return null;
  const digest = hash(secret);
  const row = store.db
    .prepare(
      `SELECT u.id,u.display_name AS displayName,t.role,t.id AS tokenId,t.secret_hash AS secretHash,t.expires_at AS expiresAt,t.revoked_at AS revokedAt,u.disabled FROM tokens t JOIN users u ON u.id=t.user_id WHERE t.secret_hash=?`,
    )
    .get(digest) as any;
  if (
    !row ||
    !equalHex(digest, row.secretHash) ||
    row.disabled ||
    row.revokedAt ||
    row.expiresAt <= now
  )
    return null;
  return {
    user: { id: row.id, displayName: row.displayName },
    role: row.role,
    tokenId: row.tokenId,
  };
}

export function createSession(store: NativeStore, identity: Identity, now = Date.now()) {
  const id = randomBytes(32).toString("base64url"),
    csrfToken = csrfFor(id);
  const token = store.db
    .prepare("SELECT expires_at FROM tokens WHERE id=? AND revoked_at IS NULL")
    .get(identity.tokenId) as { expires_at: number } | undefined;
  if (!token || token.expires_at <= now) throw new Error("invalid token");
  const expiresAt = Math.min(
    now + NATIVE_SESSION_IDLE_MS,
    now + NATIVE_SESSION_ABSOLUTE_MS,
    token.expires_at,
  );
  store.db
    .prepare(
      "INSERT INTO sessions(session_hash,user_id,token_id,csrf_hash,created_at,last_seen,expires_at) VALUES(?,?,?,?,?,?,?)",
    )
    .run(hash(id), identity.user.id, identity.tokenId, hash(csrfToken), now, now, expiresAt);
  return { id, csrfToken, expiresAt };
}

export function authenticateSession(store: NativeStore, id: string, now = Date.now()) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
  const row = store.db
    .prepare(
      `SELECT s.session_hash AS sessionHash,s.csrf_hash AS csrfHash,s.created_at AS createdAt,s.last_seen AS lastSeen,s.expires_at AS expiresAt,t.expires_at AS tokenExpires,t.revoked_at AS revokedAt,u.id,u.display_name AS displayName,u.disabled,t.role,t.id AS tokenId FROM sessions s JOIN tokens t ON t.id=s.token_id JOIN users u ON u.id=s.user_id WHERE s.session_hash=?`,
    )
    .get(hash(id)) as any;
  if (
    !row ||
    row.disabled ||
    row.revokedAt ||
    row.expiresAt <= now ||
    row.tokenExpires <= now ||
    now - row.lastSeen >= NATIVE_SESSION_IDLE_MS ||
    now - row.createdAt >= NATIVE_SESSION_ABSOLUTE_MS
  ) {
    if (row) store.db.prepare("DELETE FROM sessions WHERE session_hash=?").run(row.sessionHash);
    return null;
  }
  const expiresAt = Math.min(
    now + NATIVE_SESSION_IDLE_MS,
    row.createdAt + NATIVE_SESSION_ABSOLUTE_MS,
    row.tokenExpires,
  );
  return {
    user: { id: row.id, displayName: row.displayName },
    role: row.role as Role,
    tokenId: row.tokenId,
    csrfHash: row.csrfHash,
    csrfToken: csrfFor(id),
    expiresAt,
  };
}

export function renewSession(store: NativeStore, id: string, now = Date.now()) {
  const session = authenticateSession(store, id, now);
  if (!session) return null;
  store.db
    .prepare("UPDATE sessions SET last_seen=?,expires_at=? WHERE session_hash=?")
    .run(now, session.expiresAt, hash(id));
  return session;
}

export function verifyCsrf(expectedHash: string, supplied: string) {
  return /^[A-Za-z0-9_-]{43}$/.test(supplied) && equalHex(hash(supplied), expectedHash);
}
export function logoutSession(store: NativeStore, id: string) {
  store.db.prepare("DELETE FROM sessions WHERE session_hash=?").run(hash(id));
}
export function rotateSession(
  store: NativeStore,
  identity: Identity,
  oldId?: string,
  now = Date.now(),
) {
  if (oldId) logoutSession(store, oldId);
  return createSession(store, identity, now);
}
