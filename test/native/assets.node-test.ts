import test from "node:test";
import assert from "node:assert/strict";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { auth, fixture, listen, request } from "./helpers.ts";

test("asset API publishes, finalizes, lists and shows an exact private manifest", async () => {
  const f = fixture();
  const port = await listen(f.app.server);
  try {
    const headers = auth(f.token);
    const landing = await request(port, "GET", "/archive?return=https://evil.example", {
      host: "owner.example",
    });
    assert.equal(landing.status, 401);
    assert.equal(landing.headers.location, undefined);
    const health = await request(port, "GET", "/health", headers);
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true, service: "shlook" });
    const me = await request(port, "GET", "/api/me", headers);
    assert.deepEqual(JSON.parse(me.body), {
      backend: "native",
      user: { id: "test-user", displayName: "Test User" },
      role: "publisher",
      capabilities: ["read", "publish", "delete", "expiry"],
    });
    const created = await request(
      port,
      "POST",
      "/api/assets",
      { ...headers, "content-type": "application/json" },
      JSON.stringify({ name: "  Sample   app ", description: "local" }),
    );
    assert.equal(created.status, 201);
    const asset = JSON.parse(created.body).asset;
    assert.equal(asset.name, "Sample app");
    assert.equal(asset.visibility, "private");
    assert.equal(asset.state, "uploading");
    const content = "<!doctype html><html><body><h1>Native</h1></body></html>";
    const uploaded = await request(
      port,
      "PUT",
      `/api/assets/${asset.id}/files/index.html`,
      { ...headers, "content-length": String(Buffer.byteLength(content)) },
      content,
    );
    assert.equal(uploaded.status, 201);
    const file = JSON.parse(uploaded.body).file;
    const finalized = await request(
      port,
      "POST",
      `/api/assets/${asset.id}/finalize`,
      { ...headers, "content-type": "application/json" },
      JSON.stringify({ entrypoint: "index.html", files: [file] }),
    );
    assert.equal(finalized.status, 200);
    assert.equal(JSON.parse(finalized.body).asset.state, "live");
    for (const object of readdirSync(join(f.directory, "objects")))
      assert.equal(lstatSync(join(f.directory, "objects", object)).mode & 0o777, 0o600);
    const listed = await request(port, "GET", "/api/assets?offset=0", headers);
    assert.equal(JSON.parse(listed.body).assets.length, 1);
    const shown = await request(port, "GET", `/api/assets/${asset.id}`, headers);
    assert.equal(JSON.parse(shown.body).asset.files[0].path, "index.html");
    const viewerToken = f.store.issueToken({
      userId: "test-user",
      name: "read-only",
      role: "viewer",
    }).secret;
    assert.equal((await request(port, "GET", "/health", auth(viewerToken))).status, 200);
    assert.equal(
      (
        await request(
          port,
          "POST",
          "/api/assets",
          { ...auth(viewerToken), "content-type": "application/json" },
          JSON.stringify({ name: "Denied" }),
        )
      ).status,
      403,
    );
    const unauthorized = await request(port, "GET", "/health", {
      host: "owner.example",
      authorization: "Bearer malformed",
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.body.includes(f.token), false);
  } finally {
    await f.dispose();
  }
});

test("API rejects path tricks, duplicate manifest claims, public visibility and unsupported privacy operations", async () => {
  const f = fixture();
  const port = await listen(f.app.server);
  try {
    const headers = auth(f.token),
      created = await request(
        port,
        "POST",
        "/api/assets",
        { ...headers, "content-type": "application/json" },
        JSON.stringify({ name: "Path test" }),
      );
    const id = JSON.parse(created.body).asset.id;
    const traversal = await request(
      port,
      "PUT",
      `/api/assets/${id}/files/%2E%2E%2Foutside.txt`,
      { ...headers, "content-length": "1" },
      "x",
    );
    assert.equal(traversal.status, 400);
    const duplicate = await request(
      port,
      "PUT",
      `/api/assets/${id}/files/index.html`,
      { ...headers, "content-length": "1" },
      "x",
    );
    assert.equal(duplicate.status, 201);
    const duplicatePath = await request(
      port,
      "PUT",
      `/api/assets/${id}/files/index.html`,
      { ...headers, "content-length": "1" },
      "y",
    );
    assert.equal(duplicatePath.status, 409);
    const publicAsset = await request(
      port,
      "POST",
      "/api/assets",
      { ...headers, "content-type": "application/json" },
      JSON.stringify({ name: "No public", visibility: "public" }),
    );
    assert.equal(publicAsset.status, 400);
    assert.equal(JSON.parse(publicAsset.body).error, "unsupported_operation");
    const share = await request(port, "POST", `/api/assets/${id}/secret?mode=create`, headers);
    assert.equal(share.status, 400);
    assert.equal(JSON.parse(share.body).error, "unsupported_operation");
  } finally {
    await f.dispose();
  }
});

test("unsupported HTML fails finalization cleanly and malformed manifest paths are 400", async () => {
  const f = fixture(),
    port = await listen(f.app.server);
  try {
    const headers = auth(f.token),
      created = await request(
        port,
        "POST",
        "/api/assets",
        { ...headers, "content-type": "application/json" },
        JSON.stringify({ name: "Unsupported" }),
      );
    const id = JSON.parse(created.body).asset.id;
    const html = Buffer.from(
        '<html><body><script type="module" src="app.js"></script></body></html>',
      ),
      js = Buffer.from("export {};");
    const claims = [];
    for (const [path, data] of [
      ["index.html", html],
      ["app.js", js],
    ] as const) {
      const uploaded = await request(
        port,
        "PUT",
        `/api/assets/${id}/files/${encodeURIComponent(path)}`,
        { ...headers, "content-length": String(data.byteLength) },
        data,
      );
      assert.equal(uploaded.status, 201);
      claims.push(JSON.parse(uploaded.body).file);
    }
    const before = readdirSync(`${f.directory}/objects`).length;
    const finalized = await request(
      port,
      "POST",
      `/api/assets/${id}/finalize`,
      { ...headers, "content-type": "application/json" },
      JSON.stringify({ entrypoint: "index.html", files: claims }),
    );
    assert.equal(finalized.status, 400);
    assert.equal(JSON.parse(finalized.body).error, "unsupported_bundle");
    assert.equal(
      f.store.db.prepare("SELECT state FROM assets WHERE id=?").get(id)?.state,
      "uploading",
    );
    assert.equal(readdirSync(`${f.directory}/objects`).length, before);
    const malformed = await request(
      port,
      "POST",
      `/api/assets/${id}/finalize`,
      { ...headers, "content-type": "application/json" },
      JSON.stringify({ entrypoint: "index.html", files: [{ uploadId: claims[0]!.uploadId }] }),
    );
    assert.equal(malformed.status, 400);
    assert.equal((await request(port, "DELETE", `/api/assets/${id}`, headers)).status, 204);
    assert.equal((await f.app.assets.cleanup()).failures, 0);
    assert.equal(readdirSync(`${f.directory}/objects`).length, 0);
  } finally {
    await f.dispose();
  }
});

test("only absent-Origin top-level document navigations receive the cross-site exception", async () => {
  const f = fixture(),
    port = await listen(f.app.server);
  try {
    const headers = auth(f.token),
      created = await request(
        port,
        "POST",
        "/api/assets",
        { ...headers, "content-type": "application/json" },
        JSON.stringify({ name: "Navigate" }),
      );
    const id = JSON.parse(created.body).asset.id;
    const html = "<html><body>private</body></html>",
      upload = await request(
        port,
        "PUT",
        `/api/assets/${id}/files/index.html`,
        { ...headers, "content-length": String(html.length) },
        html,
      );
    await request(
      port,
      "POST",
      `/api/assets/${id}/finalize`,
      { ...headers, "content-type": "application/json" },
      JSON.stringify({ entrypoint: "index.html", files: [JSON.parse(upload.body).file] }),
    );
    const navigation = {
      host: "owner.example",
      authorization: `Bearer ${f.token}`,
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    };
    assert.equal((await request(port, "GET", `/assets/${id}/index.html`, navigation)).status, 200);
    assert.equal(
      (
        await request(port, "GET", `/preview/assets/${id}/index.html`, {
          host: "owner.example",
          authorization: `Bearer ${f.token}`,
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "iframe",
        })
      ).status,
      200,
    );
    const head = await request(port, "HEAD", `/assets/${id}/index.html`, navigation);
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
    assert.equal(
      (
        await request(port, "GET", "/archive", {
          host: "owner.example",
          "sec-fetch-site": "none",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
        })
      ).headers.location,
      "/login?return=%2Farchive",
    );
    assert.equal(
      (await request(port, "GET", `/assets/${id}/index.html`, { ...navigation, origin: "null" }))
        .status,
      403,
    );
    assert.equal(
      (
        await request(port, "GET", `/assets/${id}/index.html`, {
          ...navigation,
          origin: "https://evil.example",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(port, "GET", `/assets/${id}/index.html`, {
          host: "owner.example",
          authorization: `Bearer ${f.token}`,
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "no-cors",
          "sec-fetch-dest": "image",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(port, "GET", "/health", {
          host: "owner.example",
          authorization: `Bearer ${f.token}`,
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(port, "GET", "/health", {
          host: "owner.example",
          authorization: `Bearer ${f.token}`,
          "sec-fetch-site": "none",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(port, "GET", "/health", {
          host: "owner.example",
          authorization: `Bearer ${f.token}`,
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
          "sec-fetch-dest": "empty",
        })
      ).status,
      200,
    );
  } finally {
    await f.dispose();
  }
});
