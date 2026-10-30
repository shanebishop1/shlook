import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createNativeUiHandler } from "../../src/native/ui/index.ts";
import { ownerDocument } from "../../src/ui/render.ts";
import { ownerClientScript } from "../../src/ui/client-script.ts";
import { ownerStyles } from "../../src/ui/styles.ts";
import { nativeRequestScript } from "../../src/native/ui/transport.ts";
import { nativeUploadScript } from "../../src/native/ui/upload.ts";
import { loginDocument } from "../../src/native/ui/login.ts";

const name = '<script src="/attack.js"></script>&\'';
const asset = {
  id: "12345678-1234-4234-8234-123456789abc",
  name,
  description: name,
  state: "live",
  visibility: "private" as const,
  shareExpiresAt: null,
  hardExpiresAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  author: { id: "alice", displayName: name },
};

async function fixture(t: any, role: "publisher" | "viewer" = "publisher") {
  const offsets: number[] = [];
  const ui = createNativeUiHandler({
    readPage: (offset) => {
      offsets.push(offset);
      return { assets: [asset], nextOffset: offset === 0 ? 100 : null };
    },
  });
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/login")) ui.loginHandler(request, response);
    else
      void ui
        .ownerHandler(request, response, { user: { id: "alice", displayName: "Alice" }, role })
        .catch((error) => {
          response.statusCode = 500;
          response.end(error.message);
        });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { origin: `http://127.0.0.1:${address.port}`, offsets };
}

test("native archive reuses canonical markup/styles, escapes attribution and uses real offset pagination", async (t) => {
  const { origin, offsets } = await fixture(t);
  const response = await fetch(origin + "/archive");
  const html = await response.text();
  const document = new JSDOM(html).window.document;
  assert.equal(response.status, 200);
  assert.equal(document.querySelector(".artifact-name")?.textContent, name);
  assert.ok(document.querySelector("[data-detail]")?.textContent?.includes("Published by " + name));
  assert.equal(document.querySelector("style")?.textContent, ownerStyles());
  assert.equal(document.querySelector("[data-count]")?.textContent, "1 on this page");
  assert.equal(document.querySelector(".pagination a")?.getAttribute("href"), "/?offset=100");
  assert.ok(document.querySelector("[data-upload-open]"));
  assert.equal(document.querySelector("input[webkitdirectory]"), null);
  assert.equal(document.querySelector("[data-directory-picker]"), null);
  assert.equal(document.querySelector("[data-upload-input]")?.hasAttribute("multiple"), false);
  assert.ok(document.querySelector("[data-hard-expiry]"));
  const id = document.querySelector("[data-detail]")!.getAttribute("data-detail");
  const download = document.querySelector("[data-detail] a[data-download]")!;
  assert.equal(download.getAttribute("href"), `/api/assets/${id}/download`);
  assert.ok(download.hasAttribute("download"));
  assert.equal(
    document.querySelector(
      "[data-share-expiry],[data-visibility-menu],[data-secret],[data-copy-public],.upload-visibility,[data-filter-menu]",
    ),
    null,
  );
  for (const frame of document.querySelectorAll("iframe"))
    assert.equal(frame.getAttribute("sandbox"), "allow-scripts allow-downloads");
  const csp = response.headers.get("content-security-policy")!;
  assert.ok(!csp.includes("unsafe-inline"));
  const nonce = document.querySelector("style")!.getAttribute("nonce");
  assert.ok(csp.includes(`script-src 'nonce-${nonce}'`));
  for (const element of document.querySelectorAll("script,style"))
    assert.equal(element.getAttribute("nonce"), nonce);
  const nextResponse = await fetch(origin + "/?offset=100");
  const next = new JSDOM(await nextResponse.text()).window.document;
  assert.equal(next.querySelector(".pagination a")?.getAttribute("href"), "/?offset=0");
  assert.notEqual(next.querySelector("style")!.getAttribute("nonce"), nonce);
  assert.equal((await fetch(origin + "/?offset=-1")).status, 400);
  assert.deepEqual(offsets, [0, 100]);
});

test("viewer archive has no mutation controls and shared script boots without them", async (t) => {
  const { origin } = await fixture(t, "viewer");
  const dom = new JSDOM(await (await fetch(origin)).text(), {
    url: origin,
    runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  assert.equal(
    document.querySelector(
      "[data-upload-form],[data-upload-open],[data-select-toggle],[data-select-item],[data-expiry],[data-delete],[data-batch-delete]",
    ),
    null,
  );
  dom.window.matchMedia = (() => ({ matches: false })) as any;
  dom.window.requestAnimationFrame = (() => 0) as any;
  dom.window.fetch = (async () =>
    Response.json({ asset: { entrypoint: "folder/index.html" } })) as any;
  dom.window.eval([...document.querySelectorAll("script")].at(-1)!.textContent!);
  const input = document.querySelector("[data-search]") as HTMLInputElement;
  input.value = "no match";
  input.dispatchEvent(new dom.window.Event("input"));
  assert.equal((document.querySelector("[data-record]") as HTMLElement).hidden, true);
  assert.ok(document.querySelector('[aria-label="Log out"]'));
});

test("login clears the token before exchange and resumes the server-provided URL, with failure-only feedback", async () => {
  const document = new JSDOM(loginDocument("/archive?offset=100", "test")).window.document;
  const script = [...document.querySelectorAll("script")].at(-1)!.textContent!;
  let submit: any;
  const input = { value: "private-test-token", focus() {} };
  const button = { disabled: false },
    message = { textContent: "", hidden: true };
  const form = {
    addEventListener(_event: string, callback: any) {
      submit = callback;
    },
    querySelector: () => button,
    elements: { namedItem: () => ({ value: "/archive?offset=100" }) },
  };
  let destination = "";
  let succeeded = true;
  new Function("document", "fetch", "location", script)(
    {
      querySelector: (selector: string) =>
        selector === "#login" ? form : selector === "#token" ? input : message,
    },
    async (_path: string, init: RequestInit) => {
      assert.equal(input.value, "");
      assert.equal(new Headers(init.headers).get("X-Shlook-Login"), "1");
      assert.equal(JSON.parse(init.body as string).token, "private-test-token");
      return { ok: succeeded };
    },
    {
      replace: (path: string) => {
        destination = path;
      },
    },
  );
  await submit({ preventDefault() {} });
  assert.equal(destination, "/archive?offset=100");
  assert.equal(message.hidden, true);
  succeeded = false;
  button.disabled = false;
  input.value = "private-test-token";
  await submit({ preventDefault() {} });
  assert.equal(input.value, "");
  assert.equal(message.hidden, false);
  assert.equal(button.disabled, false);
  assert.ok(!message.textContent.includes("private-test-token"));
});

test("login labels the token visibly without extra copy and escapes its return value", async (t) => {
  const { origin } = await fixture(t);
  const safe = "/archive?offset=100&x=%22quoted%22";
  const response = await fetch(origin + "/login?return=" + encodeURIComponent(safe));
  const html = await response.text();
  const document = new JSDOM(html).window.document;
  assert.equal(document.querySelectorAll('input:not([type="hidden"]),button').length, 2);
  assert.equal(document.querySelector("#token")?.getAttribute("type"), "password");
  const input = document.querySelector<HTMLInputElement>("#token")!;
  const label = document.querySelector<HTMLLabelElement>('label[for="token"]')!;
  assert.equal(label.textContent, "API token");
  assert.equal(label.control, input);
  assert.equal(input.labels?.[0], label);
  assert.equal(document.querySelector("h1,h2,header,footer"), null);
  assert.equal(document.querySelector('[name="return"]')?.getAttribute("value"), safe);
  assert.equal(document.querySelector("#message")?.hasAttribute("hidden"), true);
  assert.equal(document.body.textContent?.split("const form")[0]?.trim(), "API token Sign in");
  const bad = new JSDOM(
    await (await fetch(origin + "/login?return=" + encodeURIComponent("//evil.example"))).text(),
  ).window.document;
  assert.equal(bad.querySelector('[name="return"]')?.getAttribute("value"), "/");
  assert.ok(!response.headers.get("content-security-policy")!.includes("unsafe-inline"));
});

test("Cloudflare defaults retain sharing, 24-row pagination and canonical client", () => {
  const html = ownerDocument({
    assets: [],
    hasMore: true,
    total: 25,
    offset: 0,
    ownerOrigin: "",
    privateOrigin: "",
    publicOrigin: "",
    nonce: "test",
    styles: ownerStyles(),
    script: ownerClientScript(),
  });
  const document = new JSDOM(html).window.document;
  assert.ok(document.querySelector("[data-filter-menu]"));
  assert.ok(document.querySelector('[name="upload-visibility"][value="secret_link"]'));
  assert.equal(document.querySelector(".pagination a")?.getAttribute("href"), "/?offset=24");
  assert.equal(document.querySelector("[data-count]")?.textContent, "25 artifacts");
  assert.equal(document.querySelector("input[webkitdirectory]"), null);
  assert.doesNotThrow(() => new Function(ownerClientScript()));
  assert.doesNotThrow(
    () =>
      new Function(
        ownerClientScript({
          requestScript: nativeRequestScript(),
          uploadScript: nativeUploadScript(),
        }),
      ),
  );
});
