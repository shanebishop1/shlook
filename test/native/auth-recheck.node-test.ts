import assert from "node:assert/strict";
import test from "node:test";
import { request as nativeRequest } from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { close, fixture, listen, request } from "./helpers.ts";

async function terminateChild(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

function startLockedRevoker(databasePath: string, tokenId: string) {
  const script = `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA busy_timeout=10000; BEGIN IMMEDIATE');
    console.log('LOCKED');
    process.stdin.once('data', () => {
      setTimeout(() => {
        db.prepare('UPDATE tokens SET revoked_at=? WHERE id=?').run(Date.now(), process.argv[2]);
        db.exec('COMMIT');
        console.log('REVOKED');
        db.close();
      }, 500);
    });
  `;
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", script, databasePath, tokenId],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "",
    errors = "";
  child.stdout.on("data", (chunk) => (output += chunk.toString()));
  child.stderr.on("data", (chunk) => (errors += chunk.toString()));
  const wait = (text: string) =>
    new Promise<void>((resolve, reject) => {
      if (output.includes(text)) return resolve();
      const onData = () => {
        if (!output.includes(text)) return;
        child.stdout.off("data", onData);
        resolve();
      };
      child.stdout.on("data", onData);
      child.once("error", reject);
      child.once("exit", (code) => {
        if (!output.includes(text)) reject(new Error(`revoker exited ${code}: ${errors}`));
      });
    });
  return { child, wait, trigger: () => child.stdin.end("revoke\n") };
}

function startFinalizingRevoker(databasePath: string, assetId: string, tokenId: string) {
  const script = `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA busy_timeout=10000');
    let attempts = 0;
    const check = () => {
      const row = db.prepare('SELECT state FROM assets WHERE id=?').get(process.argv[2]);
      if (row?.state === 'finalizing') {
        db.exec('BEGIN IMMEDIATE');
        db.prepare('UPDATE tokens SET revoked_at=? WHERE id=?').run(Date.now(), process.argv[3]);
        db.exec('COMMIT');
        console.log('REVOKED_DURING_FINALIZE');
        db.close();
        return;
      }
      if (row?.state === 'live' || ++attempts > 10000) {
        console.log('FINALIZE_MISSED');
        db.close();
        return;
      }
      setTimeout(check, 1);
    };
    check();
  `;
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      script,
      databasePath,
      assetId,
      tokenId,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "",
    errors = "";
  child.stdout.on("data", (chunk) => (output += chunk.toString()));
  child.stderr.on("data", (chunk) => (errors += chunk.toString()));
  const waitForRevocation = () =>
    new Promise<void>((resolve, reject) => {
      if (output.includes("REVOKED_DURING_FINALIZE")) return resolve();
      if (output.includes("FINALIZE_MISSED")) return reject(new Error(output));
      const onData = () => {
        if (output.includes("REVOKED_DURING_FINALIZE")) {
          child.stdout.off("data", onData);
          resolve();
        } else if (output.includes("FINALIZE_MISSED")) {
          child.stdout.off("data", onData);
          reject(new Error(output));
        }
      };
      child.stdout.on("data", onData);
      child.once("error", reject);
      child.once("exit", (code) => {
        if (!output.includes("REVOKED_DURING_FINALIZE"))
          reject(new Error(`finalization revoker exited ${code}: ${output} ${errors}`));
      });
    });
  return { child, waitForRevocation };
}

function slowAuthorizedJson(
  port: number,
  token: string,
  store: ReturnType<typeof fixture>["store"],
  tokenId: string,
  path: string,
  body: string,
  method = "POST",
) {
  return new Promise<number>((resolve, reject) => {
    const first = "{";
    const rest = body.slice(first.length);
    const req = nativeRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          host: "owner.example",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    req.once("error", reject);
    req.flushHeaders();
    req.write(first);
    req.once("socket", () => {
      setTimeout(() => {
        store.revokeToken(tokenId);
        req.end(rest);
      }, 20);
    });
  });
}

async function waitForReservation(store: ReturnType<typeof fixture>["store"], assetId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const count = store.db
      .prepare("SELECT COUNT(*) AS count FROM asset_uploads WHERE asset_id=? AND state='reserved'")
      .get(assetId)?.count as number;
    if (count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("upload reservation did not appear");
}

function slowUpload(
  port: number,
  path: string,
  headers: Record<string, string>,
  assetId: string,
  store: ReturnType<typeof fixture>["store"],
  onReserved: () => Promise<void>,
) {
  const data = Buffer.from("partial-upload-content");
  const first = data.subarray(0, 7);
  const rest = data.subarray(first.length);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = nativeRequest(
      {
        host: "127.0.0.1",
        port,
        method: "PUT",
        path,
        headers: { host: "owner.example", "content-length": String(data.length), ...headers },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.once("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    req.once("error", reject);
    req.flushHeaders();
    req.write(first);
    void (async () => {
      try {
        await waitForReservation(store, assetId);
        await onReserved();
        req.end(rest);
      } catch (error) {
        req.destroy(error as Error);
        reject(error);
      }
    })();
  });
}

async function createAsset(port: number, token: string) {
  const response = await request(
    port,
    "POST",
    "/api/assets",
    { host: "owner.example", authorization: `Bearer ${token}`, "content-type": "application/json" },
    JSON.stringify({ name: "recheck target", visibility: "private" }),
  );
  assert.equal(response.status, 201);
  return JSON.parse(response.body).asset.id as string;
}

test("revalidates non-expiring bearer authorization after slow create and finalize JSON bodies", async () => {
  const f = fixture();
  const port = await listen(f.app.server);
  try {
    const token = f.store.issueToken({
      userId: "test-user",
      name: "slow",
      role: "publisher",
      expiresAt: null,
    });
    const createStatus = await slowAuthorizedJson(
      port,
      token.secret,
      f.store,
      token.id,
      "/api/assets",
      JSON.stringify({ name: "revoked-create", visibility: "private" }),
    );
    assert.equal(createStatus, 401);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM assets").get()?.count, 0);

    const finalizeToken = f.store.issueToken({
      userId: "test-user",
      name: "finalize",
      role: "publisher",
      expiresAt: null,
    });
    const created = await request(
      port,
      "POST",
      "/api/assets",
      {
        host: "owner.example",
        authorization: `Bearer ${finalizeToken.secret}`,
        "content-type": "application/json",
      },
      JSON.stringify({ name: "pending", visibility: "private" }),
    );
    assert.equal(created.status, 201);
    const assetId = JSON.parse(created.body).asset.id as string;
    const bytes = Buffer.from("<h1>safe</h1>");
    const uploaded = await request(
      port,
      "PUT",
      `/api/assets/${assetId}/files/index.html`,
      {
        host: "owner.example",
        authorization: `Bearer ${finalizeToken.secret}`,
        "content-length": String(bytes.length),
      },
      bytes,
    );
    assert.equal(uploaded.status, 201);
    const file = JSON.parse(uploaded.body).file;
    const finalizeStatus = await slowAuthorizedJson(
      port,
      finalizeToken.secret,
      f.store,
      finalizeToken.id,
      `/api/assets/${assetId}/finalize`,
      JSON.stringify({
        entrypoint: "index.html",
        files: [{ path: "index.html", uploadId: file.uploadId }],
      }),
    );
    assert.equal(finalizeStatus, 401);
    assert.equal(
      (f.store.db.prepare("SELECT state FROM assets WHERE id=?").get(assetId) as { state: string })
        .state,
      "uploading",
    );

    const uploadAssetId = await createAsset(port, f.token);
    const revokedUploadToken = f.store.issueToken({
      userId: "test-user",
      name: "revoked during upload",
      role: "publisher",
      expiresAt: null,
    });
    const objectsBeforeFailedUpload = readdirSync(`${f.directory}/objects`).length;
    const stagingBeforeFailedUpload = readdirSync(`${f.directory}/staging`).length;
    const uploadStatus = await slowUpload(
      port,
      `/api/assets/${uploadAssetId}/files/nested/file.txt`,
      { authorization: `Bearer ${revokedUploadToken.secret}` },
      uploadAssetId,
      f.store,
      async () => {
        f.store.revokeToken(revokedUploadToken.id);
      },
    );
    assert.equal(uploadStatus.status, 401, uploadStatus.body);
    assert.equal(
      f.store.db
        .prepare("SELECT COUNT(*) AS count FROM asset_uploads WHERE asset_id=?")
        .get(uploadAssetId)?.count,
      0,
    );
    assert.equal(readdirSync(`${f.directory}/objects`).length, objectsBeforeFailedUpload);
    assert.equal(readdirSync(`${f.directory}/staging`).length, stagingBeforeFailedUpload);
    assert.equal(
      (
        f.store.db.prepare("SELECT state FROM assets WHERE id=?").get(uploadAssetId) as {
          state: string;
        }
      ).state,
      "uploading",
    );
    const retry = await request(
      port,
      "PUT",
      `/api/assets/${uploadAssetId}/files/nested/file.txt`,
      {
        host: "owner.example",
        authorization: `Bearer ${f.token}`,
        "content-length": "2",
      },
      "ok",
    );
    assert.equal(retry.status, 201, retry.body);

    const visibilityAssetId = await createAsset(port, f.token);
    const visibilityToken = f.store.issueToken({
      userId: "test-user",
      name: "revoked during visibility",
      role: "publisher",
      expiresAt: null,
    });
    const visibilityStatus = await slowAuthorizedJson(
      port,
      visibilityToken.secret,
      f.store,
      visibilityToken.id,
      `/api/assets/${visibilityAssetId}/visibility`,
      JSON.stringify({ visibility: "private" }),
      "PATCH",
    );
    assert.equal(visibilityStatus, 401);
    const deleteToken = f.store.issueToken({
      userId: "test-user",
      name: "revoked before delete",
      role: "publisher",
      expiresAt: null,
    });
    const deleteAssetId = await createAsset(port, f.token);
    f.store.revokeToken(deleteToken.id);
    const deniedDelete = await request(port, "DELETE", `/api/assets/${deleteAssetId}`, {
      host: "owner.example",
      authorization: `Bearer ${deleteToken.secret}`,
    });
    assert.equal(deniedDelete.status, 401);
    assert.equal(
      (
        f.store.db.prepare("SELECT state FROM assets WHERE id=?").get(deleteAssetId) as {
          state: string;
        }
      ).state,
      "uploading",
    );

    const login = await request(
      port,
      "POST",
      "/api/session",
      {
        host: "owner.example",
        origin: "https://owner.example",
        "content-type": "application/json",
        "x-shlook-login": "1",
      },
      JSON.stringify({ token: f.token }),
    );
    assert.equal(login.status, 200, login.body);
    const cookie = (login.headers["set-cookie"] as string[])[0]!.split(";", 1)[0]!;
    const csrf = JSON.parse(login.body).csrfToken as string;
    const cookieAssetId = await createAsset(port, f.token);
    const cookieUpload = slowUpload(
      port,
      `/api/assets/${cookieAssetId}/files/logout.txt`,
      { cookie, "x-shlook-csrf": csrf, origin: "https://owner.example" },
      cookieAssetId,
      f.store,
      async () => {
        const logout = await request(port, "DELETE", "/api/session", {
          host: "owner.example",
          origin: "https://owner.example",
          cookie,
          "x-shlook-csrf": csrf,
        });
        assert.equal(logout.status, 200, logout.body);
      },
    );
    const cookieUploadResult = await cookieUpload;
    assert.equal(cookieUploadResult.status, 401, cookieUploadResult.body);
    assert.equal(
      f.store.db
        .prepare("SELECT COUNT(*) AS count FROM asset_uploads WHERE asset_id=?")
        .get(cookieAssetId)?.count,
      0,
    );
  } finally {
    await close(f.app.server);
    f.app.dispose();
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("non-expiring token revocation is rechecked atomically before create and upload reservation", async () => {
  const f = fixture();
  const port = await listen(f.app.server);
  const databasePath = `${f.directory}/server.sqlite`;
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    const createToken = f.store.issueToken({
      userId: "test-user",
      name: "create lock",
      role: "publisher",
      expiresAt: null,
    });
    const createRevoker = startLockedRevoker(databasePath, createToken.id);
    child = createRevoker.child;
    await createRevoker.wait("LOCKED");
    const createPending = request(
      port,
      "POST",
      "/api/assets",
      {
        host: "owner.example",
        authorization: `Bearer ${createToken.secret}`,
        "content-type": "application/json",
      },
      JSON.stringify({ name: "must not commit" }),
    );
    createRevoker.trigger();
    const created = await createPending;
    await createRevoker.wait("REVOKED");
    assert.equal(created.status, 401, created.body);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM assets").get()?.count, 0);
    await terminateChild(child);
    child = undefined;

    const assetId = await createAsset(port, f.token);
    const uploadToken = f.store.issueToken({
      userId: "test-user",
      name: "reservation lock",
      role: "publisher",
      expiresAt: null,
    });
    const objectCount = readdirSync(`${f.directory}/objects`).length;
    const stagingCount = readdirSync(`${f.directory}/staging`).length;
    const uploadRevoker = startLockedRevoker(databasePath, uploadToken.id);
    child = uploadRevoker.child;
    await uploadRevoker.wait("LOCKED");
    const uploadPending = request(
      port,
      "PUT",
      `/api/assets/${assetId}/files/lock-race.txt`,
      {
        host: "owner.example",
        authorization: `Bearer ${uploadToken.secret}`,
        "content-length": "7",
      },
      "payload",
    );
    uploadRevoker.trigger();
    const uploaded = await uploadPending;
    await uploadRevoker.wait("REVOKED");
    assert.equal(uploaded.status, 401, uploaded.body);
    assert.equal(
      f.store.db
        .prepare("SELECT COUNT(*) AS count FROM asset_uploads WHERE asset_id=?")
        .get(assetId)?.count,
      0,
    );
    assert.equal(readdirSync(`${f.directory}/objects`).length, objectCount);
    assert.equal(readdirSync(`${f.directory}/staging`).length, stagingCount);
    const retry = await request(
      port,
      "PUT",
      `/api/assets/${assetId}/files/lock-race.txt`,
      { host: "owner.example", authorization: `Bearer ${f.token}`, "content-length": "2" },
      "ok",
    );
    assert.equal(retry.status, 201, retry.body);
  } finally {
    if (child) await terminateChild(child);
    await close(f.app.server);
    f.app.dispose();
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("separate-process non-expiring token revocation during compilation prevents commit and permits retry", async () => {
  const f = fixture();
  const port = await listen(f.app.server);
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    const assetId = await createAsset(port, f.token);
    const sourceToken = f.store.issueToken({
      userId: "test-user",
      name: "slow finalizer source",
      role: "publisher",
      expiresAt: null,
    });
    const html = `<html><body>${"<p>compile-race</p>".repeat(500_000)}</body></html>`;
    const uploaded = await request(
      port,
      "PUT",
      `/api/assets/${assetId}/files/index.html`,
      {
        host: "owner.example",
        authorization: `Bearer ${f.token}`,
        "content-length": String(Buffer.byteLength(html)),
      },
      html,
    );
    assert.equal(uploaded.status, 201, uploaded.body);
    const uploadId = JSON.parse(uploaded.body).file.uploadId as string;
    const objectCountBeforeCompile = readdirSync(`${f.directory}/objects`).length;
    const revoker = startFinalizingRevoker(`${f.directory}/server.sqlite`, assetId, sourceToken.id);
    child = revoker.child;
    const finalize = await request(
      port,
      "POST",
      `/api/assets/${assetId}/finalize`,
      {
        host: "owner.example",
        authorization: `Bearer ${sourceToken.secret}`,
        "content-type": "application/json",
      },
      JSON.stringify({ entrypoint: "index.html", files: [{ path: "index.html", uploadId }] }),
    );
    await revoker.waitForRevocation();
    assert.equal(finalize.status, 401, finalize.body);
    assert.equal(
      (f.store.db.prepare("SELECT state FROM assets WHERE id=?").get(assetId) as { state: string })
        .state,
      "uploading",
    );
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS count FROM asset_files WHERE asset_id=?").get(assetId)
        ?.count,
      0,
    );
    assert.equal(readdirSync(`${f.directory}/objects`).length, objectCountBeforeCompile);
    assert.equal(
      f.store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM asset_uploads WHERE asset_id=? AND retired_at IS NULL",
        )
        .get(assetId)?.count,
      1,
    );
    const retry = await request(
      port,
      "POST",
      `/api/assets/${assetId}/finalize`,
      {
        host: "owner.example",
        authorization: `Bearer ${f.token}`,
        "content-type": "application/json",
      },
      JSON.stringify({ entrypoint: "index.html", files: [{ path: "index.html", uploadId }] }),
    );
    assert.equal(retry.status, 200, retry.body);
    assert.equal(JSON.parse(retry.body).asset.state, "live");
  } finally {
    if (child) await terminateChild(child);
    await close(f.app.server);
    f.app.dispose();
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("non-expiring token revocation is atomic with expiry and deletion mutations", async () => {
  const f = fixture();
  const port = await listen(f.app.server);
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    const assetId = await createAsset(port, f.token);
    const html = "<html><body>atomic mutation guard</body></html>";
    const upload = await request(
      port,
      "PUT",
      `/api/assets/${assetId}/files/index.html`,
      {
        host: "owner.example",
        authorization: `Bearer ${f.token}`,
        "content-length": String(html.length),
      },
      html,
    );
    const uploadId = JSON.parse(upload.body).file.uploadId as string;
    const finalized = await request(
      port,
      "POST",
      `/api/assets/${assetId}/finalize`,
      {
        host: "owner.example",
        authorization: `Bearer ${f.token}`,
        "content-type": "application/json",
      },
      JSON.stringify({ entrypoint: "index.html", files: [{ path: "index.html", uploadId }] }),
    );
    assert.equal(finalized.status, 200, finalized.body);

    const expiryToken = f.store.issueToken({
      userId: "test-user",
      name: "expiry lock",
      role: "publisher",
      expiresAt: null,
    });
    const expiryRevoker = startLockedRevoker(`${f.directory}/server.sqlite`, expiryToken.id);
    child = expiryRevoker.child;
    await expiryRevoker.wait("LOCKED");
    const expiryPending = request(
      port,
      "PATCH",
      `/api/assets/${assetId}/expiry`,
      {
        host: "owner.example",
        authorization: `Bearer ${expiryToken.secret}`,
        "content-type": "application/json",
      },
      JSON.stringify({ hardExpiresAt: "2099-01-01T00:00:00.000Z" }),
    );
    expiryRevoker.trigger();
    const expiry = await expiryPending;
    await expiryRevoker.wait("REVOKED");
    assert.equal(expiry.status, 401, expiry.body);
    assert.equal(
      (
        f.store.db
          .prepare("SELECT hard_expires_at AS expiry FROM assets WHERE id=?")
          .get(assetId) as {
          expiry: number | null;
        }
      ).expiry,
      null,
    );
    await terminateChild(child);
    child = undefined;

    const deleteToken = f.store.issueToken({
      userId: "test-user",
      name: "delete lock",
      role: "publisher",
      expiresAt: null,
    });
    const deleteRevoker = startLockedRevoker(`${f.directory}/server.sqlite`, deleteToken.id);
    child = deleteRevoker.child;
    await deleteRevoker.wait("LOCKED");
    const deletePending = request(port, "DELETE", `/api/assets/${assetId}`, {
      host: "owner.example",
      authorization: `Bearer ${deleteToken.secret}`,
    });
    deleteRevoker.trigger();
    const deleted = await deletePending;
    await deleteRevoker.wait("REVOKED");
    assert.equal(deleted.status, 401, deleted.body);
    assert.equal(
      (f.store.db.prepare("SELECT state FROM assets WHERE id=?").get(assetId) as { state: string })
        .state,
      "live",
    );
  } finally {
    if (child) await terminateChild(child);
    await close(f.app.server);
    f.app.dispose();
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});
