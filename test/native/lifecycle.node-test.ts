import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { NativeAssetService, NativeApiError } from "../../src/native/api.ts";
import { NativeStore } from "../../src/native/store.ts";

const identity = {
  user: { id: "publisher", displayName: "Publisher" },
  role: "publisher" as const,
  tokenId: "token",
};
async function* source(data: Uint8Array) {
  yield data;
}

test("hard expiry denies immediately, delete tombstones and cleanup is restart-safe", async () => {
  const directory = mkdtempSync(join(tmpdir(), "shlook-life-"));
  let now = Date.now();
  let store = new NativeStore(directory);
  let service = new NativeAssetService(store, () => now);
  try {
    store.addUser(identity.user.id, identity.user.displayName);
    const token = store.issueToken({ userId: identity.user.id, name: "test", role: "publisher" });
    const actor = { ...identity, tokenId: token.id };
    const asset = service.create({ name: "Lifetime" }, actor);
    const html = Buffer.from("<html><body>lifecycle</body></html>");
    const file = await awaitUpload(service, asset.id, "index.html", html);
    assert.ok(file);
    service.finalize(asset.id, { entrypoint: "index.html", files: [file] });
    store.close();
    store = new NativeStore(directory);
    service = new NativeAssetService(store, () => now);
    assert.equal(service.get(asset.id).state, "live");
    service.setExpiry(asset.id, { hardExpiresAt: new Date(now + 1000).toISOString() });
    now += 1001;
    assert.throws(
      () => service.get(asset.id),
      (error) => error instanceof NativeApiError && error.status === 404,
    );
    store.close();
    store = new NativeStore(directory);
    const reopened = new NativeAssetService(store, () => now);
    assert.deepEqual(reopened.cleanup().failures, 0);
    assert.equal(
      store.db.prepare("SELECT state FROM assets WHERE id=?").get(asset.id)?.state,
      "deleted",
    );
    assert.equal(readdirObjects(reopened.objects), 0);
    reopened.delete(asset.id);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

async function awaitUpload(
  service: NativeAssetService,
  id: string,
  path: string,
  data: Uint8Array,
) {
  return service.upload(id, path, source(data), String(data.byteLength), () => {});
}
function readdirObjects(path: string) {
  return readdirSync(path).length;
}

test("upload reservation prevents finalize races and concurrent delete cannot publish bytes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "shlook-race-"));
  const store = new NativeStore(directory);
  const service = new NativeAssetService(store);
  try {
    store.addUser(identity.user.id, identity.user.displayName);
    const token = store.issueToken({ userId: identity.user.id, name: "test", role: "publisher" });
    const actor = { ...identity, tokenId: token.id };
    const asset = service.create({ name: "Race" }, actor);
    let resume!: () => void;
    const blocked = new Promise<void>((resolve) => (resume = resolve));
    let started!: () => void;
    const isStarted = new Promise<void>((resolve) => (started = resolve));
    async function* slow() {
      started();
      await blocked;
      yield Buffer.from("<html></html>");
    }
    const upload = service.upload(asset.id, "index.html", slow(), "13", () => {});
    await isStarted;
    assert.throws(
      () => service.finalize(asset.id, { entrypoint: "index.html", files: [] }),
      (error) => error instanceof NativeApiError && error.status === 409,
    );
    service.delete(asset.id);
    resume();
    await assert.rejects(
      upload,
      (error) => error instanceof NativeApiError && error.status === 409,
    );
    assert.throws(
      () => service.get(asset.id),
      (error) => error instanceof NativeApiError && error.status === 404,
    );
    assert.equal(readdirObjects(service.objects), 0);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ordinary cleanup leaves active finalization alone; startup recovery reopens interrupted work", () => {
  const directory = mkdtempSync(join(tmpdir(), "shlook-finalizing-")),
    store = new NativeStore(directory),
    service = new NativeAssetService(store);
  try {
    store.addUser(identity.user.id, identity.user.displayName);
    const token = store.issueToken({ userId: identity.user.id, name: "test", role: "publisher" });
    const asset = service.create({ name: "Finalizing" }, { ...identity, tokenId: token.id });
    const uploadId = randomUUID(),
      objectKey = randomBytes(24).toString("hex"),
      old = Date.now() - 25 * 60 * 60 * 1000;
    store.db
      .prepare(
        "INSERT INTO asset_uploads(upload_id,asset_id,path,object_key,byte_size,state,created_at,updated_at) VALUES(?,?,?,?,?,'uploaded',?,?)",
      )
      .run(uploadId, asset.id, "index.html", objectKey, 3, old, old);
    store.db.prepare("UPDATE assets SET state='finalizing' WHERE id=?").run(asset.id);
    service.cleanup(Date.now());
    assert.equal(
      store.db.prepare("SELECT state FROM assets WHERE id=?").get(asset.id)?.state,
      "finalizing",
    );
    assert.equal(
      store.db
        .prepare("SELECT COUNT(*) AS count FROM asset_uploads WHERE upload_id=?")
        .get(uploadId)?.count,
      1,
    );
    service.cleanup(Date.now(), true);
    assert.equal(
      store.db.prepare("SELECT state FROM assets WHERE id=?").get(asset.id)?.state,
      "uploading",
    );
    assert.equal(
      store.db
        .prepare("SELECT COUNT(*) AS count FROM asset_uploads WHERE upload_id=?")
        .get(uploadId)?.count,
      0,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("file count and streamed file byte limit are enforced without permanent reservations", async () => {
  const directory = mkdtempSync(join(tmpdir(), "shlook-limits-"));
  const store = new NativeStore(directory);
  const service = new NativeAssetService(store);
  try {
    store.addUser(identity.user.id, identity.user.displayName);
    const token = store.issueToken({ userId: identity.user.id, name: "test", role: "publisher" });
    const actor = { ...identity, tokenId: token.id };
    const asset = service.create({ name: "Count" }, actor);
    for (let i = 0; i < 500; i++)
      await service.upload(asset.id, `f${i}.txt`, source(Buffer.alloc(0)), "0", () => {});
    await assert.rejects(
      service.upload(asset.id, "extra.txt", source(Buffer.alloc(0)), "0", () => {}),
      (error) => error instanceof NativeApiError && error.status === 413,
    );
    const tooLarge = service.create({ name: "Too big" }, actor);
    await assert.rejects(
      service.upload(
        tooLarge.id,
        "x.bin",
        source(Buffer.alloc(25 * 1024 * 1024 + 1)),
        undefined,
        () => {},
      ),
      (error) => error instanceof NativeApiError && error.status === 413,
    );
    assert.equal(
      store.db
        .prepare("SELECT COUNT(*) AS count FROM asset_uploads WHERE asset_id=?")
        .get(tooLarge.id)?.count,
      0,
    );
    const lying = service.create({ name: "Lying length" }, actor);
    await assert.rejects(
      service.upload(lying.id, "one.txt", source(Buffer.from("longer")), "1", () => {}),
      (error) => error instanceof NativeApiError && error.status === 400,
    );
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS count FROM asset_uploads WHERE asset_id=?").get(lying.id)
        ?.count,
      0,
    );
    const missingLength = service.create({ name: "No length" }, actor);
    assert.equal(
      (
        await service.upload(
          missingLength.id,
          "one.txt",
          source(Buffer.from("ok")),
          undefined,
          () => {},
        )
      ).path,
      "one.txt",
    );

    const full = service.create({ name: "Publication cap" }, actor),
      reserve = store.db.prepare(
        "INSERT INTO asset_uploads(upload_id,asset_id,path,object_key,byte_size,state,created_at,updated_at) VALUES(?,?,?,?,?,'uploaded',?,?)",
      );
    for (let i = 0; i < 4; i++)
      reserve.run(
        randomUUID(),
        full.id,
        `reserved-${i}.dat`,
        randomBytes(24).toString("hex"),
        25 * 1024 * 1024,
        Date.now(),
        Date.now(),
      );
    await assert.rejects(
      service.upload(full.id, "last.dat", source(Buffer.alloc(0)), "1", () => {}),
      (error) => error instanceof NativeApiError && error.status === 413,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
