import { readJsonWithin } from "./request";
import { encryptSecret } from "./secret-crypto";

export type { DeploymentEnv } from "./environment";

export interface DeploymentConfig {
  ownerOrigin: string;
  privateOrigin: string;
  publicOrigin: string;
  shareOrigin: string;
  ownerEmail: string;
}

function configuredOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("shlook origins must be distinct HTTPS origins without paths");
  }
  return url.origin;
}

export function deploymentConfig(env: {
  SHLOOK_OWNER_ORIGIN: string;
  SHLOOK_PRIVATE_ORIGIN: string;
  SHLOOK_PUBLIC_ORIGIN: string;
  SHLOOK_SHARE_ORIGIN: string;
  SHLOOK_OWNER_EMAIL: string;
}): DeploymentConfig {
  const ownerOrigin = configuredOrigin(env.SHLOOK_OWNER_ORIGIN);
  const privateOrigin = configuredOrigin(env.SHLOOK_PRIVATE_ORIGIN);
  const publicOrigin = configuredOrigin(env.SHLOOK_PUBLIC_ORIGIN);
  const shareOrigin = configuredOrigin(env.SHLOOK_SHARE_ORIGIN);
  if (new Set([ownerOrigin, privateOrigin, publicOrigin, shareOrigin]).size !== 4) {
    throw new Error("shlook requires four distinct origins");
  }
  const ownerEmail = env.SHLOOK_OWNER_EMAIL.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
    throw new Error("SHLOOK_OWNER_EMAIL must be an email address");
  }
  return { ownerOrigin, privateOrigin, publicOrigin, shareOrigin, ownerEmail };
}

export interface PrivacyAsset {
  id: string;
  state: string;
  visibility: "private" | "secret_link" | "public";
  secret_hash: string | null;
  share_expires_at: string | null;
  hard_expires_at: string | null;
}

export interface PublicAsset extends PrivacyAsset {
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export function assetJson(row: PublicAsset) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    state: row.state,
    visibility: row.visibility,
    shareExpiresAt: row.share_expires_at,
    hardExpiresAt: row.hard_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function hasOwnerAccess(
  ownerEmail: string,
  ctx?: Pick<ExecutionContext, "access">,
): Promise<boolean> {
  if (ctx?.access === undefined) return false;
  try {
    const identity = await ctx.access.getIdentity();
    return identity === undefined || identity.email?.toLowerCase() === ownerEmail;
  } catch {
    return false;
  }
}

export function isPast(value: string | null, now = Date.now()): boolean {
  return value !== null && Date.parse(value) <= now;
}

export async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function artifactAccess(
  asset: PrivacyAsset,
  mode: "private" | "public" | "secret",
  secret?: string,
): Promise<"allow" | "deny" | "hard_expired"> {
  if (isPast(asset.hard_expires_at)) return "hard_expired";
  if (mode === "private") return "allow";
  if (isPast(asset.share_expires_at)) return "deny";
  if (mode === "public") return asset.visibility === "public" ? "allow" : "deny";
  return asset.visibility === "secret_link" &&
    asset.secret_hash !== null &&
    secret !== undefined &&
    (await hashSecret(secret)) === asset.secret_hash
    ? "allow"
    : "deny";
}

function issueSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function expiry(value: unknown, current: string | null): string | null | undefined {
  if (value === undefined) return current;
  if (value === null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

async function liveUpdate(
  db: D1Database,
  sql: string,
  values: (string | null)[],
  id: string,
  condition = "",
): Promise<boolean> {
  const result = await db
    .prepare(
      `${sql} WHERE id = ? AND state = 'live' AND ` +
        "(hard_expires_at IS NULL OR hard_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))" +
        condition,
    )
    .bind(...values, id)
    .run();
  return result.meta.changes === 1;
}

export async function handlePrivacyMutation(
  request: Request,
  db: D1Database,
  asset: PrivacyAsset,
  operation: "visibility" | "secret" | "expiry",
  shareOrigin: string,
  secretEncryptionKey?: string,
): Promise<Response | null> {
  if (asset.state !== "live") return json({ error: "asset_not_live" }, 409);

  if (operation === "secret" && request.method === "POST") {
    const mode = new URL(request.url).searchParams.get("mode");
    if (mode !== null && mode !== "create" && mode !== "rotate") {
      return json({ error: "invalid_secret_mode" }, 400);
    }
    if (mode === "create" && asset.secret_hash !== null) {
      return json({ error: "secret_exists" }, 409);
    }
    if (mode === "rotate" && asset.secret_hash === null) {
      return json({ error: "secret_missing" }, 409);
    }
    const secret = issueSecret();
    const hash = await hashSecret(secret);
    let encrypted;
    try {
      encrypted = await encryptSecret(secret, asset.id, secretEncryptionKey ?? "");
    } catch {
      return json({ error: "secret_encryption_unavailable" }, 500);
    }
    const condition =
      mode === "create"
        ? " AND secret_hash IS NULL"
        : mode === "rotate"
          ? " AND secret_hash IS NOT NULL"
          : "";
    const updated = await liveUpdate(
      db,
      "UPDATE assets SET secret_hash = ?, secret_ciphertext = ?, secret_iv = ?, " +
        "visibility = 'secret_link', updated_at = ?",
      [hash, encrypted.ciphertext, encrypted.iv, new Date().toISOString()],
      asset.id,
      condition,
    );
    if (!updated) {
      if (mode === "create") return json({ error: "secret_exists" }, 409);
      if (mode === "rotate") return json({ error: "secret_missing" }, 409);
      return json({ error: "asset_not_live" }, 409);
    }
    return json({ secret, url: `${shareOrigin}/s/${secret}/assets/${asset.id}/` });
  }
  if (operation === "secret" && request.method === "DELETE") {
    const updated = await liveUpdate(
      db,
      "UPDATE assets SET secret_hash = NULL, secret_ciphertext = NULL, secret_iv = NULL, " +
        "visibility = CASE WHEN visibility = 'secret_link' THEN 'private' ELSE visibility END, " +
        "updated_at = ?",
      [new Date().toISOString()],
      asset.id,
    );
    if (!updated) return json({ error: "asset_not_live" }, 409);
    return new Response(null, { status: 204 });
  }

  if (request.method !== "PATCH") return null;
  let value: unknown;
  try {
    value = await readJsonWithin(request, 16 * 1024);
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return json({ error: "invalid_request" }, 400);
  const body = value as Record<string, unknown>;

  if (operation === "visibility") {
    const visibility = body.visibility;
    if (!(["private", "secret_link", "public"] as unknown[]).includes(visibility))
      return json({ error: "invalid_visibility" }, 400);
    if (visibility === "secret_link" && asset.secret_hash === null)
      return json({ error: "secret_required" }, 409);
    const updated = await liveUpdate(
      db,
      "UPDATE assets SET visibility = ?, updated_at = ?",
      [visibility as string, new Date().toISOString()],
      asset.id,
    );
    if (!updated) return json({ error: "asset_not_live" }, 409);
    return json({ visibility });
  }

  const hasShare = Object.hasOwn(body, "shareExpiresAt");
  const hasHard = Object.hasOwn(body, "hardExpiresAt");
  if (!hasShare && !hasHard) return json({ error: "invalid_expiry" }, 400);
  const share = expiry(body.shareExpiresAt, asset.share_expires_at);
  const hard = expiry(body.hardExpiresAt, asset.hard_expires_at);
  if (share === undefined || hard === undefined) return json({ error: "invalid_expiry" }, 400);
  const now = new Date().toISOString();
  const assignments = [
    ...(hasShare ? ["share_expires_at = ?"] : []),
    ...(hasHard ? ["hard_expires_at = ?"] : []),
    "updated_at = ?",
  ].join(", ");
  const values = [...(hasShare ? [share] : []), ...(hasHard ? [hard] : []), now];
  const updated = await liveUpdate(db, `UPDATE assets SET ${assignments}`, values, asset.id);
  if (!updated) return json({ error: "asset_not_live" }, 409);
  return json({ shareExpiresAt: share, hardExpiresAt: hard });
}
