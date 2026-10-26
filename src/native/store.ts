import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeSync,
  readFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { prepareDataDirectory } from "./config.ts";

export type Role = "viewer" | "publisher";
export type User = { id: string; displayName: string; disabled: boolean };
const slug = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export class NativeStore {
  readonly db: DatabaseSync;
  readonly directory: string;
  private readonly ownsLock: boolean;
  constructor(path: string, lock = false) {
    this.directory = prepareDataDirectory(path);
    if (lock) {
      const lockPath = resolve(this.directory, "server.lock");
      let fd: number;
      try {
        fd = openSync(
          lockPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const st = lstatSync(lockPath);
        if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.())
          throw new Error("unsafe server lock");
        const contents = readFileSync(lockPath, "utf8");
        const pid = Number(contents);
        if (!Number.isSafeInteger(pid) || pid < 1)
          throw new Error("server lock is invalid; inspect it before removal");
        try {
          process.kill(pid, 0);
          throw new Error("server is already running");
        } catch (probeError) {
          if ((probeError as NodeJS.ErrnoException).code !== "ESRCH") throw probeError;
        }
        unlinkSync(lockPath);
        fd = openSync(
          lockPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
      }
      writeSync(fd, String(process.pid));
      closeSync(fd);
      chmodSync(resolve(this.directory, "server.lock"), 0o600);
      this.ownsLock = true;
    } else this.ownsLock = false;
    const databasePath = resolve(this.directory, "server.sqlite");
    try {
      if (lstatSync(databasePath).isSymbolicLink() || !lstatSync(databasePath).isFile())
        throw new Error("unsafe database file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (this.ownsLock) unlinkSync(resolve(this.directory, "server.lock"));
        throw error;
      }
    }
    for (const suffix of ["-wal", "-shm"]) {
      const path = resolve(this.directory, `server.sqlite${suffix}`);
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
          throw new Error("unsafe SQLite sidecar");
        chmodSync(path, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          if (this.ownsLock) unlinkSync(resolve(this.directory, "server.lock"));
          throw error;
        }
      }
    }
    try {
      this.db = new DatabaseSync(databasePath);
    } catch (error) {
      if (this.ownsLock) unlinkSync(resolve(this.directory, "server.lock"));
      throw error;
    }
    try {
      const databaseStat = lstatSync(databasePath);
      if (databaseStat.uid !== process.getuid?.())
        throw new Error("database is not owned by current user");
      chmodSync(databasePath, 0o600);
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
      this.secureSqliteSidecars();
      this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);");
      this.db.exec("BEGIN IMMEDIATE");
      this.db
        .exec(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, display_name TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)), created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS tokens(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('viewer','publisher')), secret_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
        CREATE UNIQUE INDEX IF NOT EXISTS active_token_names ON tokens(user_id,name) WHERE revoked_at IS NULL;
        CREATE TABLE IF NOT EXISTS sessions(session_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), token_id TEXT NOT NULL REFERENCES tokens(id), csrf_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL);
        INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);`);
      this.db.exec("COMMIT");
      this.db.exec("BEGIN IMMEDIATE");
      this.db.exec(`CREATE TABLE IF NOT EXISTS assets(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, entrypoint TEXT, state TEXT NOT NULL CHECK(state IN ('uploading','finalizing','live','deleting','deleted')),
        visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility='private'), share_expires_at INTEGER, hard_expires_at INTEGER,
        author_id TEXT NOT NULL, author_display_name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS asset_uploads(
        upload_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), path TEXT NOT NULL, object_key TEXT, byte_size INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL CHECK(state IN ('reserved','uploaded')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(asset_id,path)
      );
      CREATE TABLE IF NOT EXISTS asset_files(
        asset_id TEXT NOT NULL REFERENCES assets(id), path TEXT NOT NULL, upload_id TEXT NOT NULL REFERENCES asset_uploads(upload_id),
        object_key TEXT NOT NULL, compiled_key TEXT, byte_size INTEGER NOT NULL, mime_type TEXT NOT NULL,
        PRIMARY KEY(asset_id,path), UNIQUE(upload_id)
      );
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (2);`);
      const assetColumns = this.db.prepare("PRAGMA table_info(assets)").all() as Array<{
        name: string;
      }>;
      if (!assetColumns.some(({ name }) => name === "entrypoint"))
        this.db.exec("ALTER TABLE assets ADD COLUMN entrypoint TEXT");
      this.db.exec("INSERT OR IGNORE INTO schema_migrations(version) VALUES (3)");
      const uploadColumns = this.db.prepare("PRAGMA table_info(asset_uploads)").all() as Array<{
        name: string;
      }>;
      if (!uploadColumns.some(({ name }) => name === "retired_at"))
        this.db.exec("ALTER TABLE asset_uploads ADD COLUMN retired_at INTEGER");
      this.db.exec("INSERT OR IGNORE INTO schema_migrations(version) VALUES (4)");
      const versions = this.db
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all() as Array<{ version: number }>;
      if (versions.some(({ version }) => ![1, 2, 3, 4].includes(version)))
        throw new Error("unsupported schema migration");
      this.db.exec("COMMIT");
      for (const name of ["objects", "staging"]) {
        const path = resolve(this.directory, name);
        mkdirSync(path, { recursive: true, mode: 0o700 });
        const stat = lstatSync(path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
          throw new Error("unsafe native storage directory");
        chmodSync(path, 0o700);
      }
      this.secureSqliteSidecars();
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      this.db.close();
      if (this.ownsLock) unlinkSync(resolve(this.directory, "server.lock"));
      throw error;
    }
  }
  close() {
    try {
      this.db.close();
      this.secureSqliteSidecars();
    } finally {
      if (this.ownsLock) unlinkSync(resolve(this.directory, "server.lock"));
    }
  }
  get ownsServerLock() {
    return this.ownsLock;
  }
  private secureSqliteSidecars() {
    for (const suffix of ["-wal", "-shm"]) {
      const path = resolve(this.directory, `server.sqlite${suffix}`);
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
          throw new Error("unsafe SQLite sidecar");
        chmodSync(path, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  addUser(id: string, displayName: string): User {
    if (!slug.test(id) || !displayName.trim() || displayName.length > 120)
      throw new Error("invalid user");
    this.db
      .prepare("INSERT INTO users(id,display_name,created_at) VALUES(?,?,?)")
      .run(id, displayName.trim(), Date.now());
    return { id, displayName: displayName.trim(), disabled: false };
  }
  listUsers(): User[] {
    return this.db
      .prepare("SELECT id,display_name AS displayName,disabled FROM users ORDER BY id")
      .all()
      .map((u) => {
        const row = u as { id: string; displayName: string; disabled: number };
        return { id: row.id, displayName: row.displayName, disabled: Boolean(row.disabled) };
      });
  }
  disableUser(id: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE users SET disabled=1 WHERE id=?").run(id);
      this.db
        .prepare("UPDATE tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL")
        .run(Date.now(), id);
      this.db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  issueToken(input: { userId: string; name: string; role: Role; expiresAt?: number }) {
    if (
      !input.name.trim() ||
      input.name.length > 100 ||
      !["viewer", "publisher"].includes(input.role)
    )
      throw new Error("invalid token");
    const now = Date.now(),
      expiresAt = input.expiresAt ?? now + 90 * 86400000;
    if (expiresAt <= now || expiresAt > now + 365 * 86400000)
      throw new Error("invalid token expiry");
    const user = this.db.prepare("SELECT disabled FROM users WHERE id=?").get(input.userId) as
      | { disabled: number }
      | undefined;
    if (!user || user.disabled) throw new Error("unknown or disabled user");
    const secret = `shlook_api_v1_${randomBytes(32).toString("base64url")}`;
    const id = randomBytes(16).toString("hex");
    const hash = createHash("sha256").update(secret).digest("hex");
    this.db
      .prepare(
        "INSERT INTO tokens(id,user_id,name,role,secret_hash,created_at,expires_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(id, input.userId, input.name.trim(), input.role, hash, now, expiresAt);
    return { id, secret, expiresAt };
  }
  listTokens(userId: string) {
    return this.db
      .prepare(
        "SELECT id,name,role,created_at AS createdAt,expires_at AS expiresAt,revoked_at AS revokedAt FROM tokens WHERE user_id=? ORDER BY created_at",
      )
      .all(userId);
  }
  revokeToken(id: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE tokens SET revoked_at=? WHERE id=?").run(Date.now(), id);
      this.db.prepare("DELETE FROM sessions WHERE token_id=?").run(id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
