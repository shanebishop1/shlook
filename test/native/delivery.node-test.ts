import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { auth, close, fixture, listen, request } from "./helpers.ts";
import { NativeStore } from "../../src/native/store.ts";
import { createNativeApplication } from "../../src/native/router.ts";
import { authenticateToken } from "../../src/native/auth.ts";

test("direct, latest and preview delivery enforce sandbox headers and selected alias redirects", async () => {
  const f = fixture(),
    port = await listen(f.app.server);
  try {
    const headers = auth(f.token),
      created = await request(
        port,
        "POST",
        "/api/assets",
        { ...headers, "content-type": "application/json" },
        JSON.stringify({ name: "Delivery" }),
      );
    const id = JSON.parse(created.body).asset.id;
    const html =
      "<!doctype html><html><body><script>window.safe=true</script><h1>Page</h1></body></html>";
    const uploaded = await request(
      port,
      "PUT",
      `/api/assets/${id}/files/index.html`,
      { ...headers, "content-length": String(Buffer.byteLength(html)) },
      html,
    );
    const file = JSON.parse(uploaded.body).file;
    const final = await request(
      port,
      "POST",
      `/api/assets/${id}/finalize`,
      { ...headers, "content-type": "application/json" },
      JSON.stringify({ entrypoint: "index.html", files: [file] }),
    );
    assert.equal(final.status, 200);
    const latest = await request(
      port,
      "GET",
      `/assets/${id}/latest`,
      auth(f.token, "alias.example"),
    );
    assert.equal(latest.status, 302);
    assert.equal(latest.headers.location, `/assets/${id}/index.html`);
    for (const path of [`/assets/${id}/index.html`, `/preview/assets/${id}/index.html`]) {
      const response = await request(port, "GET", path, auth(f.token, "alias.example"));
      assert.equal(response.status, 200);
      assert.match(
        response.headers["content-security-policy"] as string,
        /^sandbox allow-scripts allow-downloads;/,
      );
      assert.equal(response.headers["x-content-type-options"], "nosniff");
      assert.equal(response.headers["cache-control"], "private, no-store");
      assert.equal(response.headers["referrer-policy"], "no-referrer");
      assert.match(response.headers["content-type"] as string, /text\/html/);
      assert.match(response.body, /window\.safe=true/);
    }
    const foreign = await request(port, "GET", `/assets/${id}/index.html`, {
      host: "owner.example",
      origin: "https://alias.example",
      authorization: `Bearer ${f.token}`,
    });
    assert.equal(foreign.status, 403);
  } finally {
    await f.dispose();
  }
});

test("unsupported active MIME is forced to attachment and unknown object paths are unavailable", async () => {
  const f = fixture(),
    port = await listen(f.app.server);
  try {
    const headers = auth(f.token),
      created = await request(
        port,
        "POST",
        "/api/assets",
        { ...headers, "content-type": "application/json" },
        JSON.stringify({ name: "Opaque" }),
      );
    const id = JSON.parse(created.body).asset.id;
    const html = "<html><body>opaque</body></html>",
      raw = "binary";
    const htmlUpload = await request(
      port,
      "PUT",
      `/api/assets/${id}/files/index.html`,
      { ...headers, "content-length": String(html.length) },
      html,
    );
    const rawUpload = await request(
      port,
      "PUT",
      `/api/assets/${id}/files/raw.unknown`,
      { ...headers, "content-length": String(raw.length) },
      raw,
    );
    const files = [JSON.parse(htmlUpload.body).file, JSON.parse(rawUpload.body).file];
    assert.equal(
      (
        await request(
          port,
          "POST",
          `/api/assets/${id}/finalize`,
          { ...headers, "content-type": "application/json" },
          JSON.stringify({ entrypoint: "index.html", files }),
        )
      ).status,
      200,
    );
    f.store.db
      .prepare("UPDATE asset_files SET compiled_key=NULL WHERE asset_id=? AND path='index.html'")
      .run(id);
    const missingCompiled = await request(port, "GET", `/assets/${id}/index.html`, headers);
    assert.equal(missingCompiled.status, 404);
    assert.equal(missingCompiled.body.includes("<html"), false);
    const download = await request(port, "GET", `/assets/${id}/raw.unknown`, headers);
    assert.equal(download.status, 200);
    assert.equal(download.headers["content-type"], "application/octet-stream");
    assert.equal(download.headers["content-disposition"], "attachment");
    assert.equal(
      download.headers["content-security-policy"]
        ?.toString()
        .startsWith("sandbox allow-scripts allow-downloads;"),
      true,
    );
    assert.equal((await request(port, "GET", `/assets/${id}/missing.js`, headers)).status, 404);
  } finally {
    await f.dispose();
  }
});

test("nested CLI-style encoded paths publish and serve compiled nested HTML/CSS/images", async () => {
  const f = fixture();
  let store = f.store,
    app = f.app,
    port = await listen(app.server),
    serverOpen = true;
  try {
    const headers = auth(f.token),
      created = await request(
        port,
        "POST",
        "/api/assets",
        { ...headers, "content-type": "application/json" },
        JSON.stringify({ name: "Nested" }),
      );
    const id = JSON.parse(created.body).asset.id;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const bundle = [
      [
        "pages/index.html",
        Buffer.from(
          '<html><head><link rel="stylesheet" href="../styles/app.css"></head><body><img src="../images/pixel.png"></body></html>',
        ),
      ],
      ["styles/app.css", Buffer.from("body { background-image: url(../images/pixel.png); }")],
      ["images/pixel.png", png],
      ["pages/help.html", Buffer.from("<html><body>help</body></html>")],
    ] as const;
    const claims = [];
    for (const [path, bytes] of bundle) {
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      const uploaded = await request(
        port,
        "PUT",
        `/api/assets/${id}/files/${encoded}`,
        { ...headers, "content-length": String(bytes.byteLength) },
        bytes,
      );
      assert.equal(uploaded.status, 201, uploaded.body);
      claims.push(JSON.parse(uploaded.body).file);
    }
    const finalized = await request(
      port,
      "POST",
      `/api/assets/${id}/finalize`,
      { ...headers, "content-type": "application/json" },
      JSON.stringify({ entrypoint: "pages/index.html", files: claims }),
    );
    assert.equal(finalized.status, 200, finalized.body);
    assert.equal(
      store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM asset_uploads WHERE asset_id=? AND retired_at IS NULL",
        )
        .get(id)?.count,
      0,
    );
    const abandoned = app.assets.create(
      { name: "Abandoned" },
      authenticateToken(store, f.token)!,
      () => {},
    );
    const abandonedFile = await app.assets.upload(
      abandoned.id,
      "stale.txt",
      (async function* () {
        yield Buffer.from("stale");
      })(),
      "5",
      () => {},
    );
    const staleKey = (
      store.db
        .prepare("SELECT object_key AS key FROM asset_uploads WHERE upload_id=?")
        .get(abandonedFile.uploadId) as { key: string }
    ).key;
    const orphanKey = randomBytes(24).toString("hex"),
      orphanPath = resolve(app.assets.objects, orphanKey);
    writeFileSync(orphanPath, "orphan");
    utimesSync(orphanPath, new Date(0), new Date(0));
    const stagingOrphan = resolve(app.assets.staging, `${randomBytes(24).toString("hex")}.part`);
    writeFileSync(stagingOrphan, "orphan");
    utimesSync(stagingOrphan, new Date(0), new Date(0));
    const protectedKeys = (
      store.db
        .prepare(
          "SELECT object_key AS key FROM asset_files WHERE asset_id=? UNION SELECT compiled_key AS key FROM asset_files WHERE asset_id=? AND compiled_key IS NOT NULL",
        )
        .all(id, id) as Array<{ key: string }>
    ).map((row) => row.key);
    app.assets.cleanup(Date.now() + 25 * 60 * 60 * 1000);
    assert.equal(existsSync(resolve(app.assets.objects, staleKey)), false);
    assert.equal(existsSync(orphanPath), false);
    assert.equal(existsSync(stagingOrphan), false);
    for (const key of protectedKeys)
      assert.equal(
        existsSync(resolve(app.assets.objects, key)),
        true,
        `cleanup removed referenced object ${key}`,
      );
    assert.equal(store.db.prepare("SELECT state FROM assets WHERE id=?").get(id)?.state, "live");
    app.dispose();
    await close(app.server);
    serverOpen = false;
    store.close();
    store = new NativeStore(f.directory);
    app = createNativeApplication({ store, config: f.config });
    port = await listen(app.server);
    serverOpen = true;
    const redirect = await request(
      port,
      "GET",
      `/assets/${id}/latest`,
      auth(f.token, "alias.example"),
    );
    assert.equal(redirect.headers.location, `/assets/${id}/pages/index.html`);
    for (const route of [
      `/assets/${id}/pages/index.html`,
      `/preview/assets/${id}/pages/index.html`,
      `/assets/${id}/pages/help.html`,
      `/assets/${id}/styles/app.css`,
      `/assets/${id}/images/pixel.png`,
    ]) {
      const response = await request(port, "GET", route, auth(f.token, "alias.example"));
      assert.equal(response.status, 200, response.body);
      assert.match(
        response.headers["content-security-policy"] as string,
        /^sandbox allow-scripts allow-downloads;/,
      );
      if (route.endsWith("index.html")) assert.match(response.body, /data:image\/png;base64,/);
    }
  } finally {
    app.dispose();
    if (serverOpen) await close(app.server);
    store.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("media files support byte ranges and downloads return the self-contained entrypoint", async () => {
  const f = fixture(),
    port = await listen(f.app.server);
  try {
    const headers = auth(f.token),
      created = await request(
        port,
        "POST",
        "/api/assets",
        { ...headers, "content-type": "application/json" },
        JSON.stringify({ name: 'Tab: "mix"' }),
      );
    const id = JSON.parse(created.body).asset.id;
    const song = Buffer.from("ID3\u0004\u0000abcdefghij");
    const html = '<!doctype html><audio controls src="song.mp3"></audio>';
    const files = [];
    for (const [path, body] of [
      ["song.mp3", song],
      ["index.html", Buffer.from(html)],
    ] as const) {
      const uploaded = await request(
        port,
        "PUT",
        `/api/assets/${id}/files/${path}`,
        { ...headers, "content-length": String(body.byteLength) },
        body,
      );
      files.push(JSON.parse(uploaded.body).file);
    }
    const final = await request(
      port,
      "POST",
      `/api/assets/${id}/finalize`,
      { ...headers, "content-type": "application/json" },
      JSON.stringify({ entrypoint: "index.html", files }),
    );
    assert.equal(final.status, 200, final.body);

    const whole = await request(port, "GET", `/assets/${id}/song.mp3`, headers);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers["content-type"], "audio/mpeg");
    assert.equal(whole.headers["accept-ranges"], "bytes");
    assert.equal(whole.headers["content-disposition"], undefined);
    const part = await request(port, "GET", `/assets/${id}/song.mp3`, {
      ...headers,
      range: "bytes=5-8",
    });
    assert.equal(part.status, 206);
    assert.equal(part.headers["content-range"], `bytes 5-8/${song.byteLength}`);
    assert.equal(part.body, "abcd");
    const suffix = await request(port, "GET", `/assets/${id}/song.mp3`, {
      ...headers,
      range: "bytes=-3",
    });
    assert.equal(suffix.body, "hij");
    const beyond = await request(port, "GET", `/assets/${id}/song.mp3`, {
      ...headers,
      range: "bytes=99-",
    });
    assert.equal(beyond.status, 416);
    assert.equal(beyond.headers["content-range"], `bytes */${song.byteLength}`);
    const page = await request(port, "GET", `/assets/${id}/index.html`, {
      ...headers,
      range: "bytes=0-3",
    });
    assert.equal(page.status, 200);
    assert.match(page.body, /src="data:audio\/mpeg;base64,/);

    const download = await request(port, "GET", `/api/assets/${id}/download`, headers);
    assert.equal(download.status, 200);
    assert.equal(download.headers["content-type"], "application/octet-stream");
    assert.equal(
      download.headers["content-disposition"],
      `attachment; filename="Tab mix.html"; filename*=UTF-8''Tab%20mix.html`,
    );
    assert.match(download.headers["content-security-policy"] as string, /^sandbox /);
    assert.equal(download.body, page.body);
    const missing = await request(
      port,
      "GET",
      `/api/assets/00000000-0000-4000-8000-000000000000/download`,
      headers,
    );
    assert.equal(missing.status, 404);
  } finally {
    await f.dispose();
  }
});
