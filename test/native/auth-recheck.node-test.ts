import assert from "node:assert/strict";
import test from "node:test";
import { request as nativeRequest } from "node:http";
import { close, fixture, listen, request } from "./helpers.ts";

function slowAuthorizedJson(
  port: number,
  token: string,
  store: ReturnType<typeof fixture>["store"],
  tokenId: string,
  path: string,
  body: string,
) {
  return new Promise<number>((resolve, reject) => {
    const first = "{";
    const rest = body.slice(first.length);
    const req = nativeRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
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
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM assets").get().count, 0);

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
  } finally {
    await close(f.app.server);
    f.app.dispose();
    f.store.close();
    const { rmSync } = await import("node:fs");
    rmSync(f.directory, { recursive: true, force: true });
  }
});
