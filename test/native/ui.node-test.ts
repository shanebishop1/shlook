import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createNativeUiHandler } from "../../src/native/ui/index.ts";

test("archive renders display names as text, not markup", async (t) => {
  const displayName = '<script src="/assets/example/attack.js"></script>&\'';
  const ui = createNativeUiHandler();
  const server = createServer((request, response) => {
    ui.ownerHandler(request, response, {
      user: { id: "alice", displayName },
      role: "publisher",
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/archive`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.ok(!html.includes(displayName));
  assert.ok(
    html.includes(
      "&lt;script src=&quot;/assets/example/attack.js&quot;&gt;&lt;/script&gt;&amp;&#39;",
    ),
  );
});
