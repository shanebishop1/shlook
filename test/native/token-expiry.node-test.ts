import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  authenticateSession,
  authenticateToken,
  createSession,
  renewSession,
} from "../../src/native/auth.ts";
import { createNativeApplication } from "../../src/native/router.ts";
import { NativeStore } from "../../src/native/store.ts";
import { tokenExpiryActive } from "../../src/native/token-expiry.ts";
import { auth, close, listen, request } from "./helpers.ts";

const DAY = 86400000;

test("token expiry defaults remain finite; only explicit null issues without expiry", () => {
  const directory = mkdtempSync(join(tmpdir(), "shlook-token-expiry-"));
  const store = new NativeStore(directory);
  try {
    store.addUser("alice", "Alice");
    const defaultToken = store.issueToken({ userId: "alice", name: "default", role: "viewer" });
    const createdAt = store.db
      .prepare("SELECT created_at FROM tokens WHERE id=?")
      .get(defaultToken.id)!.created_at as number;
    assert.equal(defaultToken.expiresAt, createdAt + 90 * DAY);
    const datedExpiry = Date.now() + 365 * DAY;
    const dated = store.issueToken({
      userId: "alice",
      name: "dated",
      role: "viewer",
      expiresAt: datedExpiry,
    });
    assert.equal(dated.expiresAt, datedExpiry);
    assert.ok(authenticateToken(store, dated.secret, datedExpiry - 1));
    assert.equal(authenticateToken(store, dated.secret, datedExpiry), null);
    const unbounded = store.issueToken({
      userId: "alice",
      name: "none",
      role: "publisher",
      expiresAt: null,
    });
    assert.equal(unbounded.expiresAt, null);
    const metadata = store.listTokens("alice");
    assert.equal(metadata.find((row) => row.id === unbounded.id)!.expiresAt, null);
    assert.equal(
      metadata.find((row) => row.id === defaultToken.id)!.expiresAt,
      defaultToken.expiresAt,
    );
    assert.ok(!JSON.stringify(metadata).includes(unbounded.secret));
    for (const expiresAt of [
      0,
      -1,
      Date.now() - 1,
      Date.now() + 366 * DAY,
      NaN,
      Infinity,
      -Infinity,
      1.5,
      "none",
      "0",
    ]) {
      assert.throws(
        () =>
          store.issueToken({
            userId: "alice",
            name: "invalid",
            role: "viewer",
            expiresAt: expiresAt as number,
          }),
        /invalid token expiry/,
      );
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("non-expiring tokens retain finite idle/absolute browser limits and immediate revocation", () => {
  const directory = mkdtempSync(join(tmpdir(), "shlook-token-session-"));
  const store = new NativeStore(directory);
  try {
    store.addUser("alice", "Alice");
    const token = store.issueToken({
      userId: "alice",
      name: "none",
      role: "viewer",
      expiresAt: null,
    });
    const start = Date.now();
    const identity = authenticateToken(store, token.secret, start)!;
    const idle = createSession(store, identity, start);
    assert.equal(idle.expiresAt, start + 30 * DAY);
    assert.equal(authenticateSession(store, idle.id, start + 30 * DAY), null);
    const active = createSession(store, identity, start);
    for (const day of [29, 58, 87, 89]) {
      const renewed = renewSession(store, active.id, start + day * DAY)!;
      assert.ok(renewed);
      assert.equal(renewed.expiresAt, start + Math.min(day + 30, 90) * DAY);
      assert.ok(Number.isFinite(renewed.expiresAt));
    }
    assert.equal(authenticateSession(store, active.id, start + 90 * DAY), null);
    const revokedSession = createSession(store, identity, start);
    store.revokeToken(token.id);
    assert.equal(authenticateToken(store, token.secret, start + 10000 * DAY), null);
    assert.equal(authenticateSession(store, revokedSession.id, start), null);
    assert.throws(() => createSession(store, identity, start), /invalid token/);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM sessions").get()!.count, 0);
    const other = store.issueToken({
      userId: "alice",
      name: "other",
      role: "viewer",
      expiresAt: null,
    });
    const otherIdentity = authenticateToken(store, other.secret)!;
    const disabledSession = createSession(store, otherIdentity);
    store.disableUser("alice");
    assert.equal(authenticateToken(store, other.secret), null);
    assert.equal(authenticateSession(store, disabledSession.id), null);
    assert.throws(() => createSession(store, otherIdentity), /invalid token/);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM sessions").get()!.count, 0);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unknown and damaged expiry values never become unbounded credentials", () => {
  const directory = mkdtempSync(join(tmpdir(), "shlook-token-corrupt-"));
  const store = new NativeStore(directory);
  try {
    const now = Date.now();
    for (const invalid of [
      null,
      undefined,
      NaN,
      Infinity,
      -Infinity,
      "0",
      "none",
      {},
      -1,
      now + 0.5,
    ])
      assert.equal(tokenExpiryActive(invalid, now), false);
    store.addUser("alice", "Alice");
    const token = store.issueToken({
      userId: "alice",
      name: "none",
      role: "viewer",
      expiresAt: null,
    });
    const identity = authenticateToken(store, token.secret)!;
    for (const invalid of ["damaged", Infinity, -Infinity, -1, now + 0.5, new Uint8Array([0])]) {
      store.db.prepare("UPDATE tokens SET expires_at=0 WHERE id=?").run(token.id);
      const session = createSession(store, identity, now);
      store.db.prepare("UPDATE tokens SET expires_at=? WHERE id=?").run(invalid, token.id);
      assert.equal(authenticateToken(store, token.secret, now), null);
      assert.throws(() => createSession(store, identity, now), /invalid token/);
      assert.equal(renewSession(store, session.id, now), null);
      assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM sessions").get()!.count, 0);
    }
    for (const invalid of [null, NaN])
      assert.throws(
        () => store.db.prepare("UPDATE tokens SET expires_at=? WHERE id=?").run(invalid, token.id),
        /NOT NULL/,
      );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("non-expiring bearer works after restart decades later through real HTTP authorization", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "shlook-token-http-"));
  let store = new NativeStore(directory);
  const config = {
    version: 1 as const,
    origin: "https://owner.example",
    aliases: [],
    allowLoopbackHttp: false,
  };
  let app = createNativeApplication({ store, config });
  let port = await listen(app.server);
  try {
    store.addUser("alice", "Alice");
    const token = store.issueToken({
      userId: "alice",
      name: "none",
      role: "publisher",
      expiresAt: null,
    });
    const finite = store.issueToken({ userId: "alice", name: "default", role: "viewer" });
    const call = (secret: string) => request(port, "GET", "/api/me", auth(secret));
    assert.equal((await call(token.secret)).status, 200);
    app.dispose();
    await close(app.server);
    store.close();
    store = new NativeStore(directory);
    app = createNativeApplication({ store, config });
    port = await listen(app.server);
    const future = Date.now() + 100 * 365 * DAY;
    // Control only the clock: HTTP, SQLite, hashing and authorization remain real.
    t.mock.method(Date, "now", () => future);
    const me = await call(token.secret);
    assert.equal(me.status, 200, me.body);
    assert.equal(JSON.parse(me.body).role, "publisher");
    assert.equal((await call(finite.secret)).status, 401);
    const created = await request(
      port,
      "POST",
      "/api/assets",
      { ...auth(token.secret), "content-type": "application/json" },
      JSON.stringify({ name: "unbounded bearer" }),
    );
    assert.equal(created.status, 201, created.body);
    const login = await request(
      port,
      "POST",
      "/api/session",
      {
        host: "owner.example",
        origin: config.origin,
        "content-type": "application/json",
        "x-shlook-login": "1",
      },
      JSON.stringify({ token: token.secret }),
    );
    assert.equal(login.status, 200, login.body);
    assert.equal(JSON.parse(login.body).expiresAt, future + 30 * DAY);
    const cookie = login.headers["set-cookie"]![0]!.split(";", 1)[0]!;
    assert.equal(
      (await request(port, "GET", "/api/me", { host: "owner.example", cookie })).status,
      200,
    );
    store.disableUser("alice");
    assert.equal((await call(token.secret)).status, 401);
    assert.equal(
      (await request(port, "GET", "/api/me", { host: "owner.example", cookie })).status,
      401,
    );
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM sessions").get()!.count, 0);
  } finally {
    t.mock.restoreAll();
    app.dispose();
    await close(app.server);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
