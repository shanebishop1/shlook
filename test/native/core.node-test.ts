import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeStore } from "../../src/native/store.ts";
import {
  authenticateSession,
  authenticateToken,
  createSession,
  renewSession,
  verifyCsrf,
} from "../../src/native/auth.ts";
import { AuthThrottle, checkLoginExchange, checkRequestBoundary } from "../../src/native/server.ts";
import { initConfig, prepareDataDirectory } from "../../src/native/config.ts";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { createNativeServer } from "../../src/native/server.ts";
import { issueToken } from "../../src/native/admin.ts";
import { DatabaseSync } from "node:sqlite";

test("tokens are stored as hashes and independently revoked; sessions persist and disable revokes both", () => {
  const directory = mkdtempSync(join(tmpdir(), "shlook-native-"));
  try {
    let store = new NativeStore(directory);
    store.addUser("alice", "Alice");
    const one = store.issueToken({ userId: "alice", name: "laptop", role: "viewer" });
    const two = store.issueToken({ userId: "alice", name: "desktop", role: "publisher" });
    assert.equal(
      (store.db.prepare("SELECT secret_hash FROM tokens WHERE id=?").get(one.id) as any)
        .secret_hash,
      awaitHash(one.secret),
    );
    assert.equal(authenticateToken(store, one.secret)?.role, "viewer");
    assert.equal(authenticateToken(store, two.secret)?.role, "publisher");
    const session = createSession(store, authenticateToken(store, one.secret)!);
    store.close();
    store = new NativeStore(directory);
    assert.ok(authenticateSession(store, session.id));
    assert.ok(
      verifyCsrf(
        (store.db.prepare("SELECT csrf_hash FROM sessions").get() as any).csrf_hash,
        session.csrfToken,
      ),
    );
    store.revokeToken(one.id);
    assert.equal(authenticateToken(store, one.secret), null);
    assert.equal(authenticateSession(store, session.id), null);
    store.disableUser("alice");
    assert.equal(authenticateToken(store, two.secret), null);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("session expiry and bounded peer/global auth throttle", () => {
  const directory = mkdtempSync(join(tmpdir(), "shlook-native-"));
  try {
    const store = new NativeStore(directory);
    store.addUser("bob", "Bob");
    const issued = store.issueToken({
      userId: "bob",
      name: "test",
      role: "viewer",
      expiresAt: Date.now() + 10000,
    });
    assert.equal(authenticateToken(store, issued.secret, Date.now() + 10000), null);
    const throttle = new AuthThrottle(2, 3, 60000, 2);
    assert.equal(throttle.allow("peer", 1), true);
    throttle.fail("peer", 1);
    throttle.fail("peer", 2);
    assert.equal(throttle.allow("peer", 3), false);
    throttle.fail("other", 4);
    assert.equal(throttle.allow("third", 5), false);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("browser sessions renew 30-day idle expiry under a 90-day absolute/token cap", () => {
  const directory = mkdtempSync(join(tmpdir(), "shlook-session-duration-"));
  try {
    const store = new NativeStore(directory),
      start = Date.now();
    store.addUser("long-session", "Long Session");
    const token = store.issueToken({
      userId: "long-session",
      name: "long",
      role: "viewer",
      expiresAt: start + 120 * 24 * 60 * 60 * 1000,
    });
    const identity = authenticateToken(store, token.secret, start)!;
    const idleSession = createSession(store, identity, start);
    assert.equal(idleSession.expiresAt, start + 30 * 24 * 60 * 60 * 1000);
    const untouched = authenticateSession(store, idleSession.id, start + 29 * 24 * 60 * 60 * 1000)!;
    assert.equal(untouched.expiresAt, start + 59 * 24 * 60 * 60 * 1000);
    assert.equal(
      (
        store.db
          .prepare("SELECT expires_at AS expiresAt FROM sessions WHERE session_hash=?")
          .get(createHash("sha256").update(idleSession.id).digest("hex")) as any
      ).expiresAt,
      idleSession.expiresAt,
    );
    const activity = renewSession(store, idleSession.id, start + 29 * 24 * 60 * 60 * 1000)!;
    assert.equal(activity.expiresAt, start + 59 * 24 * 60 * 60 * 1000);
    assert.equal(
      (
        store.db
          .prepare("SELECT expires_at AS expiresAt FROM sessions WHERE session_hash=?")
          .get(createHash("sha256").update(idleSession.id).digest("hex")) as any
      ).expiresAt,
      activity.expiresAt,
    );
    assert.equal(
      authenticateSession(store, idleSession.id, start + 60 * 24 * 60 * 60 * 1000),
      null,
    );

    const absoluteSession = createSession(store, identity, start);
    assert.ok(renewSession(store, absoluteSession.id, start + 29 * 24 * 60 * 60 * 1000));
    assert.ok(renewSession(store, absoluteSession.id, start + 58 * 24 * 60 * 60 * 1000));
    assert.ok(renewSession(store, absoluteSession.id, start + 87 * 24 * 60 * 60 * 1000));
    const beforeAbsolute = renewSession(
      store,
      absoluteSession.id,
      start + 89 * 24 * 60 * 60 * 1000,
    )!;
    assert.equal(beforeAbsolute.expiresAt, start + 90 * 24 * 60 * 60 * 1000);
    assert.equal(
      authenticateSession(store, absoluteSession.id, start + 90 * 24 * 60 * 60 * 1000),
      null,
    );

    const short = store.issueToken({
      userId: "long-session",
      name: "short",
      role: "viewer",
      expiresAt: start + 10 * 24 * 60 * 60 * 1000,
    });
    const shortSession = createSession(
      store,
      authenticateToken(store, short.secret, start)!,
      start,
    );
    assert.equal(shortSession.expiresAt, start + 10 * 24 * 60 * 60 * 1000);
    assert.equal(
      authenticateSession(store, shortSession.id, start + 10 * 24 * 60 * 60 * 1000),
      null,
    );
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("safe config, exact Host/Origin and CSRF boundaries reject foreign requests", () => {
  const directory = mkdtempSync(join(tmpdir(), "shlook-native-"));
  try {
    const config = initConfig(directory, {
      version: 1,
      origin: "https://instance.example",
      aliases: ["https://alias.example"],
      allowLoopbackHttp: false,
    });
    assert.throws(() => initConfig(directory, config), /already initialized/);
    assert.throws(() => prepareDataDirectory("relative-data"), /absolute/);
    const store = new NativeStore(directory);
    store.addUser("alice", "Alice");
    const token = store.issueToken({ userId: "alice", name: "browser", role: "viewer" });
    const session = createSession(store, authenticateToken(store, token.secret)!);
    const request = (headers: Record<string, string>, method = "GET") =>
      ({
        headers: { host: "instance.example", ...headers },
        method,
        socket: { remoteAddress: "127.0.0.1" },
      }) as unknown as IncomingMessage;
    const throttle = new AuthThrottle();
    assert.equal(
      (
        checkRequestBoundary(
          request({ host: "instance.example?evil=1", authorization: `Bearer ${token.secret}` }),
          store,
          config,
          throttle,
        ) as any
      ).status,
      400,
    );
    assert.equal(
      (
        checkRequestBoundary(
          request({ host: "INSTANCE.EXAMPLE:443", authorization: `Bearer ${token.secret}` }),
          store,
          config,
          throttle,
        ) as any
      ).kind,
      "bearer",
    );
    assert.equal(
      (
        checkRequestBoundary(
          request({
            host: "alias.example",
            origin: "https://instance.example",
            authorization: `Bearer ${token.secret}`,
          }),
          store,
          config,
          throttle,
        ) as any
      ).status,
      403,
    );
    assert.equal(
      (
        checkRequestBoundary(
          request({ host: "evil.example", authorization: `Bearer ${token.secret}` }),
          store,
          config,
          throttle,
        ) as any
      ).status,
      400,
    );
    assert.equal(
      (
        checkRequestBoundary(
          request({ origin: "https://evil.example", authorization: `Bearer ${token.secret}` }),
          store,
          config,
          throttle,
        ) as any
      ).status,
      403,
    );
    assert.equal(
      (
        checkRequestBoundary(
          request(
            {
              cookie: `__Host-shlook_session=${session.id}`,
              origin: "https://instance.example",
              "x-shlook-csrf": "wrong",
            },
            "POST",
          ),
          store,
          config,
          throttle,
        ) as any
      ).status,
      403,
    );
    assert.equal(
      checkLoginExchange(
        request(
          {
            origin: "https://instance.example",
            "content-type": "application/json",
            "x-shlook-login": "1",
          },
          "POST",
        ),
        config,
      ),
      true,
    );
    assert.equal(
      checkLoginExchange(
        request(
          { origin: "null", "content-type": "application/json", "x-shlook-login": "1" },
          "POST",
        ),
        config,
      ),
      false,
    );
    const csrfHash = createHash("sha256").update(session.csrfToken).digest("hex");
    assert.equal(verifyCsrf(csrfHash, session.csrfToken), true);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native server bootstraps and rotates login, restores CSRF after restart, then logs out", async () => {
  const directory = mkdtempSync(join(tmpdir(), "shlook-native-"));
  let store = new NativeStore(directory);
  try {
    store.addUser("alice", "Alice");
    const token = store.issueToken({ userId: "alice", name: "browser", role: "viewer" });
    const config = {
      version: 1 as const,
      origin: "https://owner.example",
      aliases: ["https://alias.example"],
      allowLoopbackHttp: false,
    };
    const createServer = () =>
      createNativeServer({
        store,
        config,
        throttle: new AuthThrottle(1, 3),
        handler: (_request, response) => {
          response.end("ok");
        },
      });
    let server = createServer();
    let port = await listen(server);
    try {
      const post = await request(
        port,
        "POST",
        "/api/session",
        {
          host: "owner.example",
          origin: "https://owner.example",
          "content-type": "application/json",
          "x-shlook-login": "1",
        },
        JSON.stringify({ token: token.secret }),
      );
      assert.equal(post.status, 200);
      const firstCookie = (post.headers["set-cookie"] as string[])[0];
      assert.match(firstCookie, /HttpOnly; SameSite=Lax/);
      const initialMaxAge = Number(/Max-Age=(\d+)/.exec(firstCookie)?.[1]);
      assert.ok(initialMaxAge > 29 * 86400 && initialMaxAge <= 30 * 86400);
      assert.match(firstCookie, /Expires=/);
      const cookie = firstCookie.split(";")[0];
      await close(server);
      store.close();
      store = new NativeStore(directory);
      server = createServer();
      port = await listen(server);
      const get = await request(port, "GET", "/api/session", { host: "owner.example", cookie });
      assert.equal(get.status, 200);
      const refreshedCookie = (get.headers["set-cookie"] as string[])[0];
      assert.ok(Number(/Max-Age=(\d+)/.exec(refreshedCookie)?.[1]) > 29 * 86400);
      const csrfToken = JSON.parse(get.body).csrfToken;
      assert.match(csrfToken, /^[A-Za-z0-9_-]{43}$/);
      const sessionHash = createHash("sha256").update(cookie.split("=")[1]).digest("hex");
      const beforeDenied = store.db
        .prepare(
          "SELECT last_seen AS lastSeen,expires_at AS expiresAt FROM sessions WHERE session_hash=?",
        )
        .get(sessionHash) as { lastSeen: number; expiresAt: number };
      const denied = await request(port, "DELETE", "/api/session", {
        host: "owner.example",
        origin: "https://owner.example",
        cookie,
        "x-shlook-csrf": "invalid",
      });
      assert.equal(denied.status, 403);
      assert.equal(denied.headers["set-cookie"], undefined);
      assert.deepEqual(
        store.db
          .prepare(
            "SELECT last_seen AS lastSeen,expires_at AS expiresAt FROM sessions WHERE session_hash=?",
          )
          .get(sessionHash),
        beforeDenied,
      );
      const rotated = await request(
        port,
        "POST",
        "/api/session",
        {
          host: "alias.example",
          origin: "https://alias.example",
          "content-type": "application/json",
          "x-shlook-login": "1",
          cookie,
        },
        JSON.stringify({ token: token.secret }),
      );
      assert.equal(rotated.status, 200);
      const nextCookie = (rotated.headers["set-cookie"] as string[])[0].split(";")[0];
      assert.equal(
        (await request(port, "GET", "/api/session", { host: "alias.example", cookie })).status,
        401,
      );
      const csrf = JSON.parse(rotated.body).csrfToken;
      const logout = await request(port, "DELETE", "/api/session", {
        host: "alias.example",
        origin: "https://alias.example",
        cookie: nextCookie,
        "x-shlook-csrf": csrf,
      });
      assert.equal(logout.status, 200);
      assert.equal(
        (await request(port, "GET", "/api/session", { host: "alias.example", cookie: nextCookie }))
          .status,
        401,
      );
      assert.equal(
        (
          await request(port, "GET", "/health", {
            host: "owner.example",
            authorization: "Bearer malformed-secret",
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await request(port, "GET", "/health", {
            host: "owner.example",
            authorization: "Bearer malformed-secret",
          })
        ).status,
        429,
      );
    } finally {
      await close(server);
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("lock recovery is limited to dead owners and failed migration releases it; private paths stay private", () => {
  const directory = mkdtempSync(join(tmpdir(), "shlook-native-"));
  const symlink = join(directory, "linked");
  try {
    const owned = new NativeStore(directory, true);
    assert.equal(lstatSync(join(directory, "server.lock")).mode & 0o777, 0o600);
    assert.equal(lstatSync(join(directory, "server.sqlite")).mode & 0o777, 0o600);
    assert.throws(() => new NativeStore(directory, true), /already running/);
    owned.addUser("alice", "Alice");
    const token = issueToken(
      owned,
      "alice",
      "host-file",
      "viewer",
      undefined,
      join(directory, "token.txt"),
    );
    assert.equal("secret" in token, false);
    assert.equal(lstatSync(join(directory, "token.txt")).mode & 0o777, 0o600);
    owned.close();
    writeFileSync(join(directory, "server.lock"), String(process.pid + 999999));
    chmodSync(join(directory, "server.lock"), 0o600);
    const recovered = new NativeStore(directory, true);
    recovered.close();
    mkdirSync(join(directory, "outside"));
    symlinkSync(join(directory, "outside"), symlink);
    assert.throws(() => prepareDataDirectory(join(symlink, "data")), /symlink/);

    const broken = join(directory, "broken");
    mkdirSync(broken);
    const db = new DatabaseSync(join(broken, "server.sqlite"));
    db.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY); INSERT INTO schema_migrations VALUES(5);",
    );
    db.close();
    assert.throws(() => new NativeStore(broken, true), /unsupported schema/);
    assert.throws(() => lstatSync(join(broken, "server.lock")), { code: "ENOENT" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("loopback HTTP config permits bearer CLI only, not browser sessions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "shlook-native-"));
  const store = new NativeStore(directory);
  try {
    store.addUser("cli", "CLI");
    const token = store.issueToken({ userId: "cli", name: "cli", role: "viewer" });
    const config = {
      version: 1 as const,
      origin: "http://127.0.0.1",
      aliases: [],
      allowLoopbackHttp: true,
    };
    const server = createNativeServer({
      store,
      config,
      handler: (_request, response) => {
        response.end("ok");
      },
    });
    const port = await listen(server);
    config.origin = `http://127.0.0.1:${port}`;
    try {
      const cli = await request(port, "GET", "/health", {
        host: `127.0.0.1:${port}`,
        authorization: `Bearer ${token.secret}`,
      });
      assert.equal(cli.status, 200);
      const login = await request(
        port,
        "POST",
        "/api/session",
        {
          host: `127.0.0.1:${port}`,
          origin: `http://127.0.0.1:${port}`,
          "content-type": "application/json",
          "x-shlook-login": "1",
        },
        JSON.stringify({ token: token.secret }),
      );
      assert.equal(login.status, 403);
      assert.equal(login.body.includes(token.secret), false);
    } finally {
      await close(server);
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent slow login bodies reserve peer/global throttle capacity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "shlook-login-throttle-")),
    store = new NativeStore(directory);
  try {
    store.addUser("login", "Login");
    const token = store.issueToken({ userId: "login", name: "browser", role: "viewer" });
    const config = {
      version: 1 as const,
      origin: "https://owner.example",
      aliases: [],
      allowLoopbackHttp: false,
    };
    const server = createNativeServer({
        store,
        config,
        throttle: new AuthThrottle(1, 1),
        handler: (_request, response) => {
          response.end("ok");
        },
      }),
      port = await listen(server);
    try {
      const body = JSON.stringify({ token: token.secret });
      let sendFirst!: () => void;
      const pending = new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            method: "POST",
            path: "/api/session",
            headers: {
              host: "owner.example",
              origin: "https://owner.example",
              "content-type": "application/json",
              "x-shlook-login": "1",
              "content-length": String(Buffer.byteLength(body)),
            },
          },
          (res) => {
            let result = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => (result += chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: result }));
          },
        );
        req.on("error", reject);
        req.flushHeaders();
        sendFirst = () => req.end(body);
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const rejected = await request(
        port,
        "POST",
        "/api/session",
        {
          host: "owner.example",
          origin: "https://owner.example",
          "content-type": "application/json",
          "x-shlook-login": "1",
        },
        body,
      );
      assert.equal(rejected.status, 429);
      assert.ok(Number(rejected.headers["retry-after"]) > 0);
      sendFirst();
      const accepted = await pending;
      assert.equal(accepted.status, 200);
    } finally {
      await close(server);
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function listen(server: ReturnType<typeof createNativeServer>) {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}
function close(server: ReturnType<typeof createNativeServer>) {
  return new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
function request(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        responseBody += chunk;
      });
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: responseBody }),
      );
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function awaitHash(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}
