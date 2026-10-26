import assert from "node:assert/strict";
import test from "node:test";
import { request as nativeRequest } from "node:http";
import { readdirSync, rmSync } from "node:fs";
import { close, fixture, listen, request } from "./helpers.ts";

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

test("revalidates bearer authorization after slow create and finalize JSON bodies", async () => {
  const f = fixture();
  const port = await listen(f.app.server);
  try {
    const token = f.store.issueToken({ userId: "test-user", name: "slow", role: "publisher" });
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
