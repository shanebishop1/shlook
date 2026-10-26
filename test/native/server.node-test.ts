import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { authenticateToken, createSession } from "../../src/native/auth.ts";
import { AuthThrottle, createNativeServer } from "../../src/native/server.ts";
import { auth, close, fixture, listen, request } from "./helpers.ts";

const id = "12345678-1234-1234-1234-123456789abc";
const artifact = `/assets/${id}/nested/hello%20world.html?safeLocation=%2Farchive&view=full`;
const navigation = {
  host: "owner.example",
  "sec-fetch-site": "cross-site",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
};

test("unauthenticated HTTPS document GET/HEAD returns to the original view after login", async () => {
  const f = fixture(),
    port = await listen(f.app.server);
  try {
    for (const path of [
      artifact,
      `/assets/${id}/`,
      `/assets/${id}/latest`,
      `/preview/assets/${id}/index.html`,
      "/?view=all",
      "/archive?offset=20",
    ]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await request(port, method, path, navigation);
        assert.equal(response.status, 302, `${method} ${path}`);
        assert.equal(response.headers.location, `/login?return=${encodeURIComponent(path)}`);
        assert.equal(response.headers["cache-control"], "private, no-store");
        assert.equal(response.headers["x-content-type-options"], "nosniff");
        assert.equal(response.headers["referrer-policy"], "no-referrer");
        assert.equal(response.headers["set-cookie"], undefined);
        assert.equal(response.body, "");
      }
    }
    const alias = await request(port, "GET", artifact, { ...navigation, host: "alias.example" });
    assert.equal(alias.status, 302);
    assert.equal(alias.headers.location, `/login?return=${encodeURIComponent(artifact)}`);
    const login = await request(port, "GET", "/login?return=%2Farchive", navigation);
    assert.notEqual(login.status, 302, "login itself must not redirect in a loop");
  } finally {
    await f.dispose();
  }
});

test("missing, malformed, expired, logged-out and revoked sessions redirect without disclosing artifacts", async () => {
  const f = fixture(),
    port = await listen(f.app.server);
  try {
    const identity = authenticateToken(f.store, f.token)!;
    const session = createSession(f.store, identity);
    const authenticated = await request(port, "GET", artifact, {
      ...navigation,
      cookie: `__Host-shlook_session=${session.id}`,
    });
    assert.equal(authenticated.status, 404, "valid sessions reach normal artifact handling");
    assert.equal(authenticated.headers.location, undefined);
    const expired = createSession(f.store, identity);
    f.store.db
      .prepare("UPDATE sessions SET expires_at=0 WHERE session_hash=?")
      .run(createHash("sha256").update(expired.id).digest("hex"));
    const loggedOut = createSession(f.store, identity);
    f.store.db
      .prepare("DELETE FROM sessions WHERE session_hash=?")
      .run(createHash("sha256").update(loggedOut.id).digest("hex"));
    const cookies = [
      "",
      "__Host-shlook_session=bad",
      `__Host-shlook_session=${session.id}!`,
      `__Host-shlook_session=${session.id}=extra`,
      `__Host-shlook_session=${session.id}; __Host-shlook_session=bad`,
      `__Host-shlook_session=${expired.id}`,
      `__Host-shlook_session=${loggedOut.id}`,
    ];
    for (const cookie of cookies) {
      const response = await request(port, "GET", artifact, { ...navigation, cookie });
      assert.equal(response.status, 302, cookie);
      assert.equal(response.headers.location, `/login?return=${encodeURIComponent(artifact)}`);
      const api = await request(port, "GET", "/api/session", { host: "owner.example", cookie });
      assert.equal(api.status, 401, cookie);
      assert.equal(api.headers.location, undefined);
    }
    const created = await request(
      port,
      "POST",
      "/api/assets",
      { ...auth(f.token), "content-type": "application/json" },
      JSON.stringify({ name: "exists" }),
    );
    assert.equal(created.status, 201);
    const existingId = JSON.parse(created.body).asset.id;
    for (const target of [id, existingId]) {
      const response = await request(port, "GET", `/assets/${target}/index.html`, navigation);
      assert.equal(response.status, 302);
      assert.equal(response.body, "");
    }
    f.store.revokeToken(identity.tokenId);
    const revoked = await request(port, "GET", artifact, {
      ...navigation,
      cookie: `__Host-shlook_session=${session.id}`,
    });
    assert.equal(revoked.status, 302);
  } finally {
    await f.dispose();
  }
});

test("CLI, fetch, subresources, iframes, bearer errors and denied requests never get login redirects", async () => {
  const f = fixture(),
    port = await listen(f.app.server);
  try {
    const cases: Array<{ path: string; headers: Record<string, string>; status: number }> = [
      { path: artifact, headers: { host: "owner.example" }, status: 401 },
      { path: artifact, headers: { ...navigation, authorization: "Bearer invalid" }, status: 401 },
      { path: artifact, headers: { ...navigation, authorization: "" }, status: 401 },
      { path: artifact, headers: { ...navigation, origin: "null" }, status: 403 },
      { path: artifact, headers: { ...navigation, origin: "https://evil.example" }, status: 403 },
      { path: artifact, headers: { ...navigation, host: "evil.example" }, status: 400 },
      {
        path: artifact,
        headers: {
          ...navigation,
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
          "sec-fetch-dest": "empty",
        },
        status: 401,
      },
      {
        path: artifact,
        headers: {
          ...navigation,
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "no-cors",
          "sec-fetch-dest": "image",
        },
        status: 401,
      },
      {
        path: artifact,
        headers: { ...navigation, "sec-fetch-site": "same-origin", "sec-fetch-dest": "iframe" },
        status: 401,
      },
      { path: artifact, headers: { ...navigation, "sec-fetch-dest": "iframe" }, status: 403 },
      { path: "/api/assets", headers: { host: "owner.example" }, status: 401 },
      { path: "/health", headers: { host: "owner.example" }, status: 401 },
      { path: "/api/assets", headers: navigation, status: 403 },
      { path: "/health", headers: navigation, status: 403 },
      { path: "/", headers: { host: "owner.example" }, status: 401 },
      { path: "/archive", headers: { host: "owner.example" }, status: 401 },
      {
        path: "/unknown",
        headers: { ...navigation, "sec-fetch-site": "same-origin" },
        status: 401,
      },
    ];
    for (const { path, headers, status } of cases) {
      const response = await request(port, "GET", path, headers);
      assert.equal(response.status, status, JSON.stringify({ path, headers }));
      assert.equal(response.headers.location, undefined);
    }
    for (const method of ["POST", "PUT", "DELETE"]) {
      const response = await request(port, method, artifact, {
        ...navigation,
        "sec-fetch-site": "same-origin",
      });
      assert.equal(response.status, 401);
      assert.equal(response.headers.location, undefined);
    }
  } finally {
    await f.dispose();
  }
});

test("HTTP loopback remains bearer-only and rate-limited bearer failures remain 429", async () => {
  const f = fixture();
  const config = { ...f.config, origin: "http://127.0.0.1", aliases: [], allowLoopbackHttp: true };
  const server = createNativeServer({
    store: f.store,
    config,
    throttle: new AuthThrottle(1, 1),
    handler: (_req, res) => {
      res.end("ok");
    },
  });
  const port = await listen(server);
  try {
    for (const path of [artifact, "/", "/archive", "/login", "/ui/app.js"]) {
      const response = await request(port, "GET", path, {
        ...navigation,
        host: "127.0.0.1",
        "sec-fetch-site": "same-origin",
      });
      assert.equal(response.status, 401, path);
      assert.equal(response.headers.location, undefined);
    }
    assert.equal((await request(port, "GET", "/health", auth(f.token, "127.0.0.1"))).status, 200);
    config.origin = f.config.origin;
    const first = await request(port, "GET", artifact, {
      ...navigation,
      authorization: "Bearer invalid",
    });
    assert.equal(first.status, 401);
    const limited = await request(port, "GET", artifact, {
      ...navigation,
      authorization: "Bearer invalid",
    });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.location, undefined);
    assert.ok(Number(limited.headers["retry-after"]) > 0);
  } finally {
    await close(server);
    f.app.dispose();
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("unsafe or oversized return targets cannot escape the local login destination", async () => {
  const f = fixture(),
    port = await listen(f.app.server);
  try {
    for (const path of [
      `/assets/${id}/index.html?q=%0d%0aLocation%3Ahttps%3A%2F%2Fevil.example`,
      `/assets/${id}/nested/%252e%252e/index.html`,
      `/assets/${id}/index.html?q=${"a".repeat(4096)}`,
    ]) {
      const response = await request(port, "GET", path, navigation);
      assert.equal(response.status, 302);
      assert.equal(response.headers.location, "/login?return=%2F");
      assert.equal(response.body, "");
    }
  } finally {
    await f.dispose();
  }
});
