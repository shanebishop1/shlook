import { expect, test, type Page, type Route } from "@playwright/test";

import { artifactHeaders, manifestKey, uploadKey } from "../../src/worker/artifact.ts";
import { serveWithPolicy } from "../../src/worker/artifact-delivery.ts";
import type { AssetRow } from "../../src/worker/asset-store.ts";
import type { Env } from "../../src/worker/environment.ts";
import { hashSecret } from "../../src/worker/privacy.ts";

const origin = {
  owner: "https://owner.example.com",
  private: "https://private.example.com",
  public: "https://public.example.com",
  share: "https://share.example.com",
} as const;
const id = {
  preview: "11111111-1111-4111-8111-111111111111",
  public: "22222222-2222-4222-8222-222222222222",
  capability: "33333333-3333-4333-8333-333333333333",
  sibling: "44444444-4444-4444-8444-444444444444",
} as const;
const secret = "A".repeat(43);
const pixel = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  ),
  (character) => character.charCodeAt(0),
);

interface FileFixture {
  path: string;
  uploadId: string;
  body: string | Uint8Array;
  contentType: string;
}

class MemoryR2 {
  private readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  put(key: string, file: FileFixture): void {
    this.objects.set(key, {
      bytes: typeof file.body === "string" ? new TextEncoder().encode(file.body) : file.body,
      contentType: file.contentType,
    });
  }

  async get(key: string): Promise<R2Object | null> {
    const object = this.objects.get(key);
    if (object === undefined) return null;
    const bytes = object.bytes.slice();
    return {
      body: new Response(bytes).body,
      httpEtag: `"${key}"`,
      writeHttpMetadata(headers: Headers) {
        headers.set("content-type", object.contentType);
      },
      async json<T>(): Promise<T> {
        return JSON.parse(new TextDecoder().decode(bytes)) as T;
      },
    } as unknown as R2Object;
  }

  bucket(): R2Bucket {
    return this as unknown as R2Bucket;
  }
}

function asset(
  id: string,
  visibility: AssetRow["visibility"],
  secretHash: string | null = null,
): AssetRow {
  return {
    id,
    state: "live",
    visibility,
    manifest_id: "fixture",
    secret_hash: secretHash,
  } as AssetRow;
}

function env(bucket: MemoryR2): Env {
  return {
    ASSETS: bucket.bucket(),
    DB: {} as D1Database,
    SHLOOK_OWNER_ORIGIN: origin.owner,
    SHLOOK_PRIVATE_ORIGIN: origin.private,
    SHLOOK_PUBLIC_ORIGIN: origin.public,
    SHLOOK_SHARE_ORIGIN: origin.share,
    SHLOOK_OWNER_EMAIL: "owner@example.com",
  };
}

function addAsset(bucket: MemoryR2, row: AssetRow, files: FileFixture[]): void {
  bucket.put(manifestKey(row.id, "fixture"), {
    path: "fixture.json",
    uploadId: "55555555-5555-4555-8555-555555555555",
    body: JSON.stringify({
      version: 1,
      entrypoint: "index.html",
      files: files.map(({ path, uploadId }) => ({ path, uploadId })),
    }),
    contentType: "application/json",
  });
  for (const file of files) bucket.put(uploadKey(row.id, file.uploadId), file);
}

interface Fixture {
  bucket: MemoryR2;
  env: Env;
  assets: Map<string, AssetRow>;
}

function fixture(): Fixture {
  const bucket = new MemoryR2();
  return { bucket, env: env(bucket), assets: new Map() };
}

async function workerResponse(fixture: Fixture, url: URL): Promise<Response | null> {
  const preview =
    url.origin === origin.owner && url.pathname.match(/^\/preview\/assets\/([^/]+)(?:\/(.*))?$/);
  const privateAsset =
    url.origin === origin.private && url.pathname.match(/^\/assets\/([^/]+)(?:\/(.*))?$/);
  const publicAsset =
    url.origin === origin.public && url.pathname.match(/^\/assets\/([^/]+)(?:\/(.*))?$/);
  const capability =
    url.origin === origin.share && url.pathname.match(/^\/s\/([^/]+)\/assets\/([^/]+)(?:\/(.*))?$/);

  if (preview) {
    return serveWithPolicy(
      fixture.env,
      fixture.assets.get(preview[1]) ?? null,
      preview[2] ?? "",
      "private",
      undefined,
      true,
    );
  }
  if (privateAsset) {
    return serveWithPolicy(
      fixture.env,
      fixture.assets.get(privateAsset[1]) ?? null,
      privateAsset[2] ?? "",
      "private",
    );
  }
  if (publicAsset) {
    return serveWithPolicy(
      fixture.env,
      fixture.assets.get(publicAsset[1]) ?? null,
      publicAsset[2] ?? "",
      "public",
    );
  }
  if (capability) {
    return serveWithPolicy(
      fixture.env,
      fixture.assets.get(capability[2]) ?? null,
      capability[3] ?? "",
      "secret",
      capability[1],
    );
  }
  return null;
}

async function fulfill(route: Route, response: Response): Promise<void> {
  await route.fulfill({
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: Buffer.from(await response.arrayBuffer()),
  });
}

async function routeEverything(page: Page, fixture: Fixture, parent: string) {
  const requests: string[] = [];
  const unexpected: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/test-parent") {
      await route.fulfill({ contentType: "text/html", body: parent });
      return;
    }
    const response = await workerResponse(fixture, url);
    if (response !== null) {
      await fulfill(route, response);
      return;
    }
    if (url.href === "https://evil.example/external.js") {
      await route.fulfill({
        contentType: "text/javascript",
        body: 'document.documentElement.dataset.external = "ran";',
      });
      return;
    }
    if (url.href === "https://evil.example/image.png") {
      await route.fulfill({ contentType: "image/png", body: Buffer.from(pixel) });
      return;
    }
    if (url.href === "https://evil.example/frame.html") {
      await route.fulfill({
        contentType: "text/html",
        body: "<script>parent.document.title = 'escaped';</script>",
      });
      return;
    }
    if (
      url.href === `${origin.owner}/api/assets` ||
      url.href === `${origin.owner}/preview/assets/${id.sibling}/data.json`
    ) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
      return;
    }
    unexpected.push(url.href);
    await route.abort();
  });
  return { requests, unexpected };
}

test("enforces artifact access and browser policies with real worker responses", async ({
  page,
}) => {
  const testFixture = fixture();
  const preview = asset(id.preview, "private");
  const publicAsset = asset(id.public, "public");
  const capabilityAsset = asset(id.capability, "secret_link", await hashSecret(secret));
  for (const row of [preview, publicAsset, capabilityAsset]) testFixture.assets.set(row.id, row);

  const graph = (prefix: string): FileFixture[] => [
    {
      path: "index.html",
      uploadId: `${prefix}-0000-4000-8000-000000000001`,
      contentType: "text/html",
      body: '<!doctype html><body data-root="pending"><script type="module" src="root.js"></script></body>',
    },
    {
      path: "root.js",
      uploadId: `${prefix}-0000-4000-8000-000000000002`,
      contentType: "text/javascript",
      body: 'import { value } from "./nested/module.js"; const data = await (await fetch("./data.json")).json(); document.body.dataset.root = value; document.body.dataset.json = data.value;',
    },
    {
      path: "nested/module.js",
      uploadId: `${prefix}-0000-4000-8000-000000000003`,
      contentType: "text/javascript",
      body: 'export const value = "nested-loaded";',
    },
    {
      path: "data.json",
      uploadId: `${prefix}-0000-4000-8000-000000000004`,
      contentType: "application/json",
      body: JSON.stringify({ value: "json-loaded" }),
    },
  ];
  addAsset(testFixture.bucket, publicAsset, graph("77777777"));
  addAsset(testFixture.bucket, capabilityAsset, graph("88888888"));
  addAsset(testFixture.bucket, preview, [
    {
      path: "index.html",
      uploadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      contentType: "text/html",
      body: `<!doctype html><html><head><script>document.documentElement.dataset.inline = "ok";</script><link rel="stylesheet" href="style.css"><script src="classic.js"></script><script src="https://evil.example/external.js"></script></head><body><div id="styled">styled</div><img id="local" src="image.png"><img id="external" src="https://evil.example/image.png"><iframe src="https://evil.example/frame.html"></iframe><script>fetch("${origin.owner}/api/assets").then(() => document.body.dataset.api = "allowed", () => document.body.dataset.api = "blocked"); fetch("${origin.owner}/preview/assets/${id.sibling}/data.json").then(() => document.body.dataset.sibling = "allowed", () => document.body.dataset.sibling = "blocked");</script></body></html>`,
    },
    {
      path: "classic.js",
      uploadId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      contentType: "text/javascript",
      body: 'document.documentElement.dataset.classic = "ok";',
    },
    {
      path: "style.css",
      uploadId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      contentType: "text/css",
      body: "#styled { color: rgb(1, 2, 3); }",
    },
    {
      path: "image.png",
      uploadId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      contentType: "image/png",
      body: pixel,
    },
  ]);

  await page.addInitScript(() => {
    const windowWithViolations = globalThis as typeof globalThis & {
      __shlookCspViolations?: Array<{ blockedURI: string; effectiveDirective: string }>;
    };
    windowWithViolations.__shlookCspViolations = [];
    (globalThis as any).addEventListener("securitypolicyviolation", (event: any) => {
      windowWithViolations.__shlookCspViolations?.push({
        blockedURI: event.blockedURI,
        effectiveDirective: event.effectiveDirective,
      });
    });
  });

  const previewUrl = `${origin.owner}/preview/assets/${id.preview}/`;
  const parent = `<!doctype html><body><iframe src="${previewUrl}"></iframe></body>`;
  const { requests, unexpected } = await routeEverything(page, testFixture, parent);
  const navigation = page.waitForEvent(
    "framenavigated",
    (frame) => frame !== page.mainFrame() && frame.url().startsWith(previewUrl),
  );
  await page.goto(`${origin.owner}/test-parent`);
  const previewFrame = await navigation;
  await previewFrame.waitForLoadState("load");

  await expect.poll(() => previewFrame.locator("html").getAttribute("data-inline")).toBe("ok");
  await expect.poll(() => previewFrame.locator("html").getAttribute("data-classic")).toBe("ok");
  await expect.poll(() => previewFrame.locator("body").getAttribute("data-api")).toBe("blocked");
  await expect
    .poll(() => previewFrame.locator("body").getAttribute("data-sibling"))
    .toBe("blocked");
  await expect
    .poll(() =>
      previewFrame
        .locator("#styled")
        .evaluate((node) => (node as any).ownerDocument.defaultView.getComputedStyle(node).color),
    )
    .toBe("rgb(1, 2, 3)");
  await expect
    .poll(() =>
      previewFrame
        .locator("#local")
        .evaluate((image) => (image as any).complete && (image as any).naturalWidth > 0),
    )
    .toBe(true);
  expect(await previewFrame.evaluate(() => (globalThis as any).origin)).toBe("null");
  expect(
    await previewFrame.evaluate(() => {
      try {
        return (globalThis as any).parent.document.body.textContent;
      } catch (error) {
        return (error as any).name ?? String(error);
      }
    }),
  ).toBe("SecurityError");
  expect(
    await previewFrame.locator("#external").evaluate((image) => (image as any).naturalWidth),
  ).toBe(0);
  expect(await previewFrame.locator("html").getAttribute("data-external")).toBeNull();
  expect(page.frames().some((frame) => frame.url() === "https://evil.example/frame.html")).toBe(
    false,
  );

  await expect
    .poll(async () => {
      const violations = await previewFrame.evaluate(
        () => (globalThis as any).__shlookCspViolations ?? [],
      );
      return [
        ["script-src-elem", "evil.example/external.js"],
        ["img-src", "evil.example/image.png"],
        ["connect-src", "/api/assets"],
        ["connect-src", `/preview/assets/${id.sibling}/data.json`],
        ["frame-src", "evil.example"],
      ].every(([directive, blocked]) =>
        violations.some(
          (violation: any) =>
            violation.effectiveDirective === directive && violation.blockedURI.includes(blocked),
        ),
      );
    })
    .toBe(true);

  const normalCspObject = await testFixture.bucket.get(
    uploadKey(publicAsset.id, "77777777-0000-4000-8000-000000000001"),
  );
  expect(normalCspObject).not.toBeNull();
  const normalCsp = artifactHeaders(normalCspObject as R2Object).get("content-security-policy");
  const publicUrl = `${origin.public}/assets/${publicAsset.id}/`;
  const publicResponse = await page.goto(publicUrl);
  expect(publicResponse?.headers()["access-control-allow-origin"]).toBe("*");
  expect(publicResponse?.headers()["content-security-policy"]).toBe(normalCsp);
  await expect(page.locator("body")).toHaveAttribute("data-root", "nested-loaded");
  await expect(page.locator("body")).toHaveAttribute("data-json", "json-loaded");

  const capabilityUrl = `${origin.share}/s/${secret}/assets/${capabilityAsset.id}/`;
  const capabilityResponse = await page.goto(capabilityUrl);
  expect(capabilityResponse?.headers()["access-control-allow-origin"]).toBe("*");
  await expect(page.locator("body")).toHaveAttribute("data-root", "nested-loaded");
  await expect(page.locator("body")).toHaveAttribute("data-json", "json-loaded");

  const previewResponse = await workerResponse(testFixture, new URL(previewUrl));
  const privateResponse = await workerResponse(
    testFixture,
    new URL(`${origin.private}/assets/${id.preview}/`),
  );
  expect(previewResponse?.headers.get("access-control-allow-origin")).toBeNull();
  expect(privateResponse?.headers.get("access-control-allow-origin")).toBeNull();
  expect(requests).toContain(`${publicUrl}root.js`);
  expect(requests).toContain(`${publicUrl}nested/module.js`);
  expect(requests).toContain(`${publicUrl}data.json`);
  expect(requests).toContain(`${capabilityUrl}root.js`);
  expect(requests).toContain(`${capabilityUrl}nested/module.js`);
  expect(requests).toContain(`${capabilityUrl}data.json`);
  expect(requests).toContain(`${origin.owner}/preview/assets/${id.preview}/classic.js`);
  expect(requests).toContain(`${origin.owner}/preview/assets/${id.preview}/style.css`);
  expect(requests).toContain(`${origin.owner}/preview/assets/${id.preview}/image.png`);
  expect(unexpected).toEqual([]);
});
