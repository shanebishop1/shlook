import {
  closeSync,
  chmodSync,
  createWriteStream,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { normalizeAssetMetadata } from "../worker/asset-metadata.ts";
import {
  maxPublicationBytes,
  maxUploadBytes,
  maxUploadFiles,
  abandonedUploadMilliseconds,
} from "../upload-limits.ts";
import { compileNativeBundle, UnsupportedBundleError } from "./bundle.ts";
import type { NativeStore } from "./store.ts";
import type { Identity } from "./auth.ts";
import { NATIVE_SESSION_IDLE_MS } from "./auth.ts";

export type NativeAsset = {
  id: string;
  name: string;
  description: string | null;
  state: string;
  visibility: "private";
  shareExpiresAt: null;
  hardExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  author: { id: string; displayName: string };
  entrypoint?: string;
  files?: Array<{ path: string; size: number; mimeType: string }>;
};
export class NativeApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.name = "NativeApiError";
    this.status = status;
    this.code = code;
  }
}
const fail = (status: number, code: string): never => {
  throw new NativeApiError(status, code);
};
const safeId = /^[0-9a-f-]{36}$/i;
const fileMime: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};
const randomKey = () => randomBytes(24).toString("hex");
function nowIso(value: number) {
  return new Date(value).toISOString();
}
function rowAsset(row: any): NativeAsset {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    state: row.state,
    visibility: "private",
    shareExpiresAt: null,
    hardExpiresAt: row.hardExpiresAt === null ? null : nowIso(row.hardExpiresAt),
    createdAt: nowIso(row.createdAt),
    updatedAt: nowIso(row.updatedAt),
    author: { id: row.authorId, displayName: row.authorDisplayName },
    ...(typeof row.entrypoint === "string" ? { entrypoint: row.entrypoint } : {}),
  };
}
export function canonicalAssetPath(path: string): string {
  if (
    typeof path !== "string" ||
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    Array.from(path).some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    }) ||
    path.endsWith("/")
  )
    fail(400, "invalid_path");
  try {
    if (decodeURIComponent(path) !== path) fail(400, "invalid_path");
  } catch {
    return fail(400, "invalid_path");
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) fail(400, "invalid_path");
  return path;
}
export function decodeAssetPath(encoded: string): string {
  if (typeof encoded !== "string" || !encoded || encoded.startsWith("/") || encoded.endsWith("/"))
    return fail(400, "invalid_path");
  const decoded = encoded
    .split("/")
    .map((segment) => {
      let value: string;
      try {
        value = decodeURIComponent(segment);
      } catch {
        return fail(400, "invalid_path");
      }
      if (
        !value ||
        value === "." ||
        value === ".." ||
        value.includes("/") ||
        value.includes("\\") ||
        Array.from(value).some((character) => {
          const code = character.codePointAt(0)!;
          return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
        }) ||
        encodeURIComponent(value) !== segment
      )
        return fail(400, "invalid_path");
      return value;
    })
    .join("/");
  return canonicalAssetPath(decoded);
}
export function mimeTypeForPath(path: string) {
  return fileMime[path.split(".").at(-1)!.toLowerCase()] ?? "application/octet-stream";
}

export class NativeAssetService {
  readonly objects: string;
  readonly staging: string;
  readonly store: NativeStore;
  private readonly now: () => number;
  constructor(store: NativeStore, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
    this.objects = resolve(store.directory, "objects");
    this.staging = resolve(store.directory, "staging");
  }
  private asset(id: string, liveOnly = false): any {
    if (!safeId.test(id)) return fail(404, "not_found");
    const row = this.store.db
      .prepare(
        "SELECT id,name,description,entrypoint,state,hard_expires_at AS hardExpiresAt,author_id AS authorId,author_display_name AS authorDisplayName,created_at AS createdAt,updated_at AS updatedAt FROM assets WHERE id=?",
      )
      .get(id) as any;
    if (
      !row ||
      row.state === "deleted" ||
      row.state === "deleting" ||
      (liveOnly &&
        (row.state !== "live" || (row.hardExpiresAt !== null && row.hardExpiresAt <= this.now())))
    )
      return fail(404, "not_found");
    return row;
  }
  list(offset: number): { assets: NativeAsset[]; nextOffset: number | null } {
    if (!Number.isSafeInteger(offset) || offset < 0) return fail(400, "invalid_offset");
    const rows = this.store.db
      .prepare(
        "SELECT id,name,description,state,hard_expires_at AS hardExpiresAt,author_id AS authorId,author_display_name AS authorDisplayName,created_at AS createdAt,updated_at AS updatedAt FROM assets WHERE state='live' AND (hard_expires_at IS NULL OR hard_expires_at>?) ORDER BY created_at DESC,id LIMIT 101 OFFSET ?",
      )
      .all(this.now(), offset) as any[];
    const page = rows.slice(0, 100).map(rowAsset);
    return { assets: page, nextOffset: rows.length > 100 ? offset + 100 : null };
  }
  create(input: unknown, identity: Identity, assertAuthorized: () => void): NativeAsset {
    if (identity.role !== "publisher") return fail(403, "forbidden");
    const value = input as any;
    const metadata =
      value && typeof value === "object"
        ? normalizeAssetMetadata(value.name, value.description)
        : null;
    if (!metadata) return fail(400, "invalid_metadata");
    if (value.visibility !== undefined && value.visibility !== "private")
      return fail(400, "unsupported_operation");
    if (value.shareExpiresAt !== undefined || value.secret !== undefined)
      return fail(400, "unsupported_operation");
    const now = this.now(),
      id = randomUUID();
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      assertAuthorized();
      this.store.db
        .prepare(
          "INSERT INTO assets(id,name,description,state,author_id,author_display_name,created_at,updated_at) VALUES(?,?,?,'uploading',?,?,?,?)",
        )
        .run(
          id,
          metadata.name,
          metadata.description,
          identity.user.id,
          identity.user.displayName,
          now,
          now,
        );
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.rollback();
      throw error;
    }
    return rowAsset({
      id,
      name: metadata.name,
      description: metadata.description,
      state: "uploading",
      hardExpiresAt: null,
      authorId: identity.user.id,
      authorDisplayName: identity.user.displayName,
      createdAt: now,
      updatedAt: now,
    });
  }
  get(id: string): NativeAsset {
    const row = this.asset(id, true);
    const files = this.store.db
      .prepare(
        "SELECT path,byte_size AS size,mime_type AS mimeType FROM asset_files WHERE asset_id=? ORDER BY path",
      )
      .all(id) as Array<{ path: string; size: number; mimeType: string }>;
    return { ...rowAsset(row), files };
  }
  async upload(
    id: string,
    path: string,
    request: AsyncIterable<Uint8Array>,
    contentLength: string | undefined,
    assertAuthorized: () => void,
  ): Promise<{ path: string; uploadId: string }> {
    assertAuthorized();
    canonicalAssetPath(path);
    if (
      contentLength !== undefined &&
      (!/^(0|[1-9][0-9]*)$/.test(contentLength) || !Number.isSafeInteger(Number(contentLength)))
    )
      return fail(400, "invalid_content_length");
    const declared = contentLength === undefined ? maxUploadBytes : Number(contentLength);
    if (declared > maxUploadBytes) return fail(413, "file_too_large");
    const uploadId = randomUUID(),
      now = this.now(),
      objectKey = randomKey(),
      tempKey = randomKey();
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      assertAuthorized();
      const asset = this.asset(id);
      if (asset.state !== "uploading") fail(409, "lifecycle_conflict");
      const counts = this.store.db
        .prepare(
          "SELECT COUNT(*) AS count,COALESCE(SUM(byte_size),0) AS bytes FROM asset_uploads WHERE asset_id=?",
        )
        .get(id) as { count: number; bytes: number };
      if (
        this.store.db
          .prepare("SELECT 1 FROM asset_uploads WHERE asset_id=? AND path=?")
          .get(id, path)
      )
        fail(409, "file_already_uploaded");
      if (counts.count >= maxUploadFiles) fail(413, "file_count_exceeded");
      if (counts.bytes + declared > maxPublicationBytes) fail(413, "publication_too_large");
      this.store.db
        .prepare(
          "INSERT INTO asset_uploads(upload_id,asset_id,path,object_key,byte_size,state,created_at,updated_at) VALUES(?,?,?,?,?,'reserved',?,?)",
        )
        .run(uploadId, id, path, null, declared, now, now);
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.rollback();
      throw error;
    }
    const tempPath = resolve(this.staging, `${tempKey}.part`),
      objectPath = resolve(this.objects, objectKey);
    let bytes = 0;
    try {
      let lastProgress = this.now();
      const meter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          bytes += chunk.length;
          const current = this.now();
          if (current - lastProgress >= 30_000) {
            this.store.db
              .prepare(
                "UPDATE asset_uploads SET updated_at=? WHERE upload_id=? AND state='reserved'",
              )
              .run(current, uploadId);
            lastProgress = current;
          }
          callback(
            bytes > maxUploadBytes ? new NativeApiError(413, "file_too_large") : null,
            chunk,
          );
        },
      });
      const out = createWriteStream(tempPath, { flags: "wx", mode: 0o600 });
      await pipeline(request, meter, out);
      if (contentLength !== undefined && bytes !== declared) fail(400, "content_length_mismatch");
      chmodSync(tempPath, 0o600);
      this.syncFile(tempPath);
      renameSync(tempPath, objectPath);
      this.syncDirectory(this.objects);
      this.store.db.exec("BEGIN IMMEDIATE");
      try {
        const currentAsset = this.store.db
          .prepare("SELECT state FROM assets WHERE id=?")
          .get(id) as { state: string } | undefined;
        if (currentAsset?.state !== "uploading") fail(409, "lifecycle_conflict");
        const currentUpload = this.store.db
          .prepare("SELECT state FROM asset_uploads WHERE upload_id=?")
          .get(uploadId) as { state: string } | undefined;
        if (currentUpload?.state !== "reserved") fail(409, "lifecycle_conflict");
        const other = this.store.db
          .prepare(
            "SELECT COALESCE(SUM(byte_size),0) AS bytes FROM asset_uploads WHERE asset_id=? AND upload_id<>?",
          )
          .get(id, uploadId) as { bytes: number };
        if (other.bytes + bytes > maxPublicationBytes) fail(413, "publication_too_large");
        this.store.db
          .prepare(
            "UPDATE asset_uploads SET object_key=?,byte_size=?,state='uploaded',updated_at=? WHERE upload_id=? AND state='reserved'",
          )
          .run(objectKey, bytes, this.now(), uploadId);
        this.store.db
          .prepare("UPDATE assets SET updated_at=? WHERE id=? AND state='uploading'")
          .run(this.now(), id);
        assertAuthorized();
        this.store.db.exec("COMMIT");
      } catch (error) {
        this.rollback();
        throw error;
      }
      return { path, uploadId };
    } catch (error) {
      rmSync(tempPath, { force: true });
      rmSync(objectPath, { force: true });
      this.store.db
        .prepare("DELETE FROM asset_uploads WHERE upload_id=? AND state='reserved'")
        .run(uploadId);
      throw error;
    }
  }
  finalize(id: string, input: unknown, assertAuthorized: () => void): NativeAsset {
    const value = input as any;
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.entrypoint !== "string" ||
      !Array.isArray(value.files) ||
      value.files.length > maxUploadFiles
    )
      return fail(400, "invalid_manifest");
    const entrypoint = canonicalAssetPath(value.entrypoint);
    const claims = value.files.map((item: any) => ({
      path: canonicalAssetPath(item?.path),
      uploadId: item?.uploadId,
    }));
    if (
      claims.some((claim: any) => typeof claim.uploadId !== "string") ||
      new Set(claims.map((c: any) => c.path)).size !== claims.length ||
      new Set(claims.map((c: any) => c.uploadId)).size !== claims.length
    )
      return fail(400, "invalid_manifest");
    this.store.db.exec("BEGIN IMMEDIATE");
    let rows: any[];
    try {
      assertAuthorized();
      const asset = this.asset(id);
      if (asset.state !== "uploading") fail(409, "lifecycle_conflict");
      const allUploads = this.store.db
        .prepare(
          "SELECT upload_id AS uploadId,path,object_key AS objectKey,byte_size AS byteSize,state FROM asset_uploads WHERE asset_id=? ORDER BY path",
        )
        .all(id) as any[];
      if (allUploads.some((row) => row.state !== "uploaded")) fail(409, "upload_in_progress");
      rows = allUploads;
      if (
        rows.length !== claims.length ||
        claims.some(
          (claim: any) =>
            !rows.some((row) => row.uploadId === claim.uploadId && row.path === claim.path),
        )
      )
        fail(400, "invalid_manifest");
      if (!rows.length || !rows.some((row) => row.path === entrypoint))
        fail(400, "invalid_entrypoint");
      this.store.db
        .prepare("UPDATE assets SET state='finalizing',updated_at=? WHERE id=?")
        .run(this.now(), id);
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.rollback();
      throw error;
    }
    const compiledKeys: string[] = [];
    try {
      const files = new Map<string, Uint8Array>();
      for (const row of rows) files.set(row.path, this.readObject(row.objectKey, row.byteSize));
      const compiled = compileNativeBundle(files, entrypoint);
      for (const [path, html] of compiled) {
        const key = randomKey(),
          filePath = resolve(this.objects, key);
        writeFileSync(filePath, html, { flag: "wx", mode: 0o600 });
        chmodSync(filePath, 0o600);
        this.syncFile(filePath);
        compiledKeys.push(key);
        (rowForPath(rows, path) as any).compiledKey = key;
      }
      this.syncDirectory(this.objects);
      this.store.db.exec("BEGIN IMMEDIATE");
      try {
        assertAuthorized();
        const current = this.store.db.prepare("SELECT state FROM assets WHERE id=?").get(id) as
          | { state: string }
          | undefined;
        if (current?.state !== "finalizing") fail(409, "lifecycle_conflict");
        const insert = this.store.db.prepare(
          "INSERT INTO asset_files(asset_id,path,upload_id,object_key,compiled_key,byte_size,mime_type) VALUES(?,?,?,?,?,?,?)",
        );
        for (const row of rows)
          insert.run(
            id,
            row.path,
            row.uploadId,
            row.objectKey,
            row.compiledKey ?? null,
            row.byteSize,
            mimeTypeForPath(row.path),
          );
        this.store.db
          .prepare(
            "UPDATE assets SET state='live',entrypoint=?,updated_at=? WHERE id=? AND state='finalizing'",
          )
          .run(entrypoint, this.now(), id);
        this.store.db
          .prepare("UPDATE asset_uploads SET retired_at=? WHERE asset_id=? AND retired_at IS NULL")
          .run(this.now(), id);
        this.store.db.exec("COMMIT");
      } catch (error) {
        this.rollback();
        throw error;
      }
      return this.get(id);
    } catch (error) {
      for (const key of compiledKeys) rmSync(resolve(this.objects, key), { force: true });
      this.store.db
        .prepare("UPDATE assets SET state='uploading' WHERE id=? AND state='finalizing'")
        .run(id);
      if (error instanceof UnsupportedBundleError) fail(400, "unsupported_bundle");
      throw error;
    }
  }
  delete(id: string, assertAuthorized: () => void) {
    if (!safeId.test(id)) return fail(404, "not_found");
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      assertAuthorized();
      const asset = this.store.db.prepare("SELECT state FROM assets WHERE id=?").get(id) as
        | { state: string }
        | undefined;
      if (!asset) return fail(404, "not_found");
      if (asset.state === "finalizing") return fail(409, "lifecycle_conflict");
      if (asset.state !== "deleted")
        this.store.db
          .prepare("UPDATE assets SET state='deleting',updated_at=? WHERE id=?")
          .run(this.now(), id);
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.rollback();
      throw error;
    }
    const current = this.store.db.prepare("SELECT state FROM assets WHERE id=?").get(id) as
      | { state: string }
      | undefined;
    if (current?.state === "deleted") return;
    this.cleanAsset(id);
  }
  setExpiry(id: string, input: unknown, assertAuthorized: () => void) {
    const value = (input as any)?.hardExpiresAt;
    if (value !== null && (typeof value !== "string" || !Number.isFinite(Date.parse(value))))
      return fail(400, "invalid_expiry");
    const timestamp = value === null ? null : Date.parse(value);
    this.store.db.exec("BEGIN IMMEDIATE");
    const updatedAt = this.now();
    try {
      assertAuthorized();
      const row = this.asset(id);
      if (row.state !== "live") return fail(409, "lifecycle_conflict");
      const result = this.store.db
        .prepare("UPDATE assets SET hard_expires_at=?,updated_at=? WHERE id=? AND state='live'")
        .run(timestamp, updatedAt, id);
      if (!result.changes) fail(409, "lifecycle_conflict");
      this.store.db.exec("COMMIT");
      return rowAsset({ ...row, hardExpiresAt: timestamp, updatedAt });
    } catch (error) {
      this.rollback();
      throw error;
    }
  }
  setVisibility(id: string, input: unknown, assertAuthorized: () => void) {
    if ((input as any)?.visibility !== "private") return fail(400, "unsupported_operation");
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      assertAuthorized();
      const asset = this.get(id);
      this.store.db.exec("COMMIT");
      return asset;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }
  readFile(id: string, path: string, preview = false) {
    const row = this.asset(id, true);
    const file = this.store.db
      .prepare(
        "SELECT path,object_key AS objectKey,compiled_key AS compiledKey,byte_size AS byteSize,mime_type AS mimeType FROM asset_files WHERE asset_id=? AND path=?",
      )
      .get(id, path) as any;
    if (!file) return fail(404, "not_found");
    const html = /\.html?$/i.test(path);
    if (html && !file.compiledKey) return fail(404, "not_found");
    const key = html ? file.compiledKey : file.objectKey;
    if (preview && html && !file.compiledKey) return fail(404, "not_found");
    return {
      asset: rowAsset(row),
      path,
      bytes: this.readObject(key, html ? undefined : file.byteSize),
      mimeType: file.mimeType,
      html,
      compiled: Boolean(file.compiledKey),
    };
  }
  cleanup(now = this.now(), recoverInterruptedFinalizing = false) {
    if (recoverInterruptedFinalizing)
      this.store.db
        .prepare("UPDATE assets SET state='uploading',updated_at=? WHERE state='finalizing'")
        .run(now);
    this.store.db
      .prepare(
        "UPDATE assets SET state='deleting',updated_at=? WHERE state='live' AND hard_expires_at IS NOT NULL AND hard_expires_at<=?",
      )
      .run(now, now);
    const deleting = this.store.db
      .prepare("SELECT id FROM assets WHERE state='deleting'")
      .all() as Array<{ id: string }>;
    let cleaned = 0,
      failures = 0;
    for (const { id } of deleting) {
      try {
        this.cleanAsset(id);
        cleaned++;
      } catch {
        failures++;
      }
    }
    const stale = this.store.db
      .prepare(
        "SELECT u.upload_id,u.object_key AS objectKey FROM asset_uploads u JOIN assets a ON a.id=u.asset_id LEFT JOIN asset_files f ON f.upload_id=u.upload_id WHERE u.retired_at IS NULL AND u.state IN ('reserved','uploaded') AND u.updated_at<=? AND a.state<>'finalizing' AND f.upload_id IS NULL",
      )
      .all(now - abandonedUploadMilliseconds) as Array<{
      upload_id: string;
      objectKey: string | null;
    }>;
    for (const item of stale) {
      if (item.objectKey) rmSync(resolve(this.objects, item.objectKey), { force: true });
      this.store.db.prepare("DELETE FROM asset_uploads WHERE upload_id=?").run(item.upload_id);
      cleaned++;
    }
    for (const name of readdirSync(this.staging)) {
      const path = resolve(this.staging, name);
      const stat = lstatSync(path);
      if (now - stat.mtimeMs >= abandonedUploadMilliseconds)
        rmSync(path, { recursive: true, force: true });
    }
    const used = new Set(
      (
        this.store.db
          .prepare(
            "SELECT object_key AS k FROM asset_files UNION SELECT compiled_key AS k FROM asset_files WHERE compiled_key IS NOT NULL UNION SELECT object_key AS k FROM asset_uploads WHERE state='uploaded'",
          )
          .all() as Array<{ k: string }>
      ).map((r) => r.k),
    );
    for (const name of readdirSync(this.objects)) {
      const path = resolve(this.objects, name);
      const st = lstatSync(path);
      if (!st.isFile() || st.isSymbolicLink()) continue;
      if (!used.has(name) && now - st.mtimeMs >= abandonedUploadMilliseconds)
        rmSync(path, { force: true });
    }
    this.store.db
      .prepare("DELETE FROM sessions WHERE expires_at<=? OR last_seen<=?")
      .run(now, now - NATIVE_SESSION_IDLE_MS);
    return { cleaned, failures };
  }
  private cleanAsset(id: string) {
    const keys = this.store.db
      .prepare(
        "SELECT object_key AS key FROM asset_files WHERE asset_id=? UNION SELECT object_key AS key FROM asset_uploads WHERE asset_id=? AND object_key IS NOT NULL",
      )
      .all(id, id) as Array<{ key: string }>;
    for (const { key } of keys)
      if (/^[0-9a-f]{48}$/.test(key)) rmSync(resolve(this.objects, key), { force: true });
    const compiled = this.store.db
      .prepare(
        "SELECT compiled_key AS key FROM asset_files WHERE asset_id=? AND compiled_key IS NOT NULL",
      )
      .all(id) as Array<{ key: string }>;
    for (const { key } of compiled)
      if (/^[0-9a-f]{48}$/.test(key)) rmSync(resolve(this.objects, key), { force: true });
    this.store.db.prepare("DELETE FROM asset_files WHERE asset_id=?").run(id);
    this.store.db.prepare("DELETE FROM asset_uploads WHERE asset_id=?").run(id);
    this.store.db
      .prepare("UPDATE assets SET state='deleted',updated_at=? WHERE id=?")
      .run(this.now(), id);
  }
  private readObject(key: string, expected?: number): Uint8Array {
    if (!/^[0-9a-f]{48}$/.test(key)) return fail(404, "not_found");
    const path = resolve(this.objects, key),
      stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (expected !== undefined && stat.size !== expected)
    )
      return fail(404, "not_found");
    return readFileSync(path);
  }
  private syncFile(path: string) {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  private syncDirectory(path: string) {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  private rollback() {
    try {
      this.store.db.exec("ROLLBACK");
    } catch {}
  }
}
function rowForPath(rows: any[], path: string) {
  return rows.find((row) => row.path === path);
}
