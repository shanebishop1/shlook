import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { initConfig } from "../../src/native/config.ts";
import { run } from "../../src/native/main.ts";
import { createNativeApplication } from "../../src/native/router.ts";
import { listenLoopback } from "../../src/native/server.ts";
import { NativeStore } from "../../src/native/store.ts";

test("server executable runs through an installed-bin symlink", () => {
  const parent = mkdtempSync(join(tmpdir(), "shlook-server-bin-"));
  try {
    const bin = join(parent, "shlook-server");
    const dataDir = join(parent, "instance");
    symlinkSync(fileURLToPath(new URL("../../src/native/main.ts", import.meta.url)), bin);
    const result = spawnSync(
      process.execPath,
      [bin, "init", "--data-dir", dataDir, "--origin", "https://shlook.example"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
    assert.equal(JSON.parse(readFileSync(join(dataDir, "server.json"), "utf8")).version, 1);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("server admin entrypoint initializes, manages users/tokens, and requires secure token output", async () => {
  const parent = mkdtempSync(join(tmpdir(), "shlook-server-admin-"));
  const dataDir = join(parent, "instance");
  const tokenFile = join(parent, "token");
  try {
    await run(["init", "--data-dir", dataDir, "--origin", "https://shlook.example"]);
    await assert.rejects(
      run(["init", "--data-dir", dataDir, "--origin", "https://shlook.example"]),
    );
    await assert.rejects(run(["user", "list", "--data-dir", join(parent, "uninitialized")]));
    await assert.rejects(run(["user", "list", "--data-dir", dataDir, "--unknown", "value"]));
    await run(["user", "add", "alice", "--display-name", "Alice", "--data-dir", dataDir]);
    await run(["user", "list", "--data-dir", dataDir]);
    await assert.rejects(
      run([
        "token",
        "issue",
        "--user",
        "alice",
        "--name",
        "no-output",
        "--role",
        "viewer",
        "--data-dir",
        dataDir,
      ]),
      /local TTY or --token-file/,
    );
    await run([
      "token",
      "issue",
      "--user",
      "alice",
      "--name",
      "test",
      "--role",
      "publisher",
      "--data-dir",
      dataDir,
      "--token-file",
      tokenFile,
    ]);
    const secret = readFileSync(tokenFile, "utf8").trim();
    assert.match(secret, /^shlook_api_v1_[A-Za-z0-9_-]+$/);
    assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
    await run(["token", "list", "--user", "alice", "--data-dir", dataDir]);
    await run(["token", "revoke", "missing-token", "--data-dir", dataDir]);
    await run(["user", "disable", "alice", "--data-dir", dataDir]);
    await run(["cleanup", "--data-dir", dataDir]);
    await assert.rejects(
      run([
        "user",
        "add",
        "bob",
        "--display-name",
        "Bob",
        "--data-dir",
        dataDir,
        "--display-name",
        "Again",
      ]),
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("request logger runs before immediate responses and emits only safe route metadata", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "shlook-server-logging-"));
  initConfig(dataDir, {
    version: 1,
    origin: "https://shlook.example",
    aliases: [],
    allowLoopbackHttp: false,
  });
  const store = new NativeStore(dataDir);
  store.addUser("alice", "Alice");
  const token = store.issueToken({ userId: "alice", name: "test", role: "viewer" }).secret;
  const config = {
    version: 1 as const,
    origin: "http://127.0.0.1",
    aliases: [],
    allowLoopbackHttp: true,
  };
  const app = createNativeApplication({ store, config });
  const logs: string[] = [];
  const { attachRequestLogging } = await import("../../src/native/main.ts");
  attachRequestLogging(app.server, (line) => logs.push(line));
  try {
    await listenLoopback(app.server, "127.0.0.1", 0);
    const address = app.server.address();
    assert.ok(address && typeof address === "object");
    config.origin = `http://127.0.0.1:${address.port}`;
    const request = (host: string, authorization?: string) =>
      new Promise<{ status: number; requestId: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: address.port,
            path: "/health?secret=query-secret",
            headers: {
              Host: host,
              ...(authorization ? { Authorization: authorization } : {}),
            },
          },
          (response) => {
            response.resume();
            response.once("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                requestId: String(response.headers["x-request-id"] ?? ""),
              }),
            );
          },
        );
        req.once("error", reject);
        req.end();
      });
    const ok = await request(`127.0.0.1:${address.port}`, `Bearer ${token}`);
    assert.equal(ok.status, 200);
    const unauthorized = await request(`127.0.0.1:${address.port}`);
    assert.equal(unauthorized.status, 401);
    const badHost = await request("evil.example");
    assert.equal(badHost.status, 400);
    const stillAlive = await request(`127.0.0.1:${address.port}`);
    assert.equal(stillAlive.status, 401);
    const requestIds = [ok, unauthorized, badHost, stillAlive].map(({ requestId }) => requestId);
    assert.ok(requestIds.every((id) => /^[0-9a-f-]{36}$/.test(id)));
    assert.equal(new Set(requestIds).size, 4);
    assert.deepEqual(
      logs.map((line) => line.split(" ").slice(0, 3)),
      [
        ["GET", "api", "200"],
        ["GET", "api", "401"],
        ["GET", "api", "400"],
        ["GET", "api", "401"],
      ],
    );
    const logText = logs.join("\n");
    assert.ok(!logText.includes(token));
    assert.ok(!logText.includes("query-secret"));
    assert.ok(!logText.includes("evil.example"));
    assert.ok(!logText.includes("127.0.0.1:"));
  } finally {
    app.dispose();
    await new Promise<void>((resolve, reject) =>
      app.server.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
