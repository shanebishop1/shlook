import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { Server } from "node:http";
import { NativeStore } from "../../src/native/store.ts";
import { createNativeApplication } from "../../src/native/router.ts";

export function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "shlook-api-"));
  const store = new NativeStore(directory);
  store.addUser("test-user", "Test User");
  const token = store.issueToken({ userId: "test-user", name: "test", role: "publisher" }).secret;
  const config = {
    version: 1 as const,
    origin: "https://owner.example",
    aliases: ["https://alias.example"],
    allowLoopbackHttp: false,
  };
  const app = createNativeApplication({ store, config });
  return {
    directory,
    store,
    token,
    config,
    app,
    dispose: async () => {
      app.dispose();
      await close(app.server);
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
export function listen(server: Server) {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}
export function close(server: Server) {
  return new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
export function request(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string | Uint8Array,
) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
        );
      });
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    },
  );
}
export const auth = (token: string, host = "owner.example") => ({
  host,
  authorization: `Bearer ${token}`,
});
