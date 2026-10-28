import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { request as httpRequest, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { NativeStore } from "../../src/native/store.ts";
import { issueToken } from "../../src/native/admin.ts";
import { createNativeApplication } from "../../src/native/router.ts";
import { createNativeUiHandler } from "../../src/native/ui/index.ts";
import { validateConfig } from "../../src/native/config.ts";

const listen = (server: HttpServer | HttpsServer) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve((server.address() as { port: number }).port);
    });
  });
const close = (server: HttpServer | HttpsServer) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

test("native UI login, uploads, persistent sessions, revocation, and viewer policy over HTTPS", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const directory = mkdtempSync(join(tmpdir(), "shlook-native-browser-"));
  const certDir = join(directory, "cert");
  mkdirSync(certDir);
  const key = join(certDir, "key.pem"),
    cert = join(certDir, "cert.pem");
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  let store: NativeStore | undefined;
  let app: ReturnType<typeof createNativeApplication> | undefined;
  const proxy = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) });
  const port = await listen(proxy);
  const httpsOrigin = `https://127.0.0.1:${port}`;
  const external = createHttpsServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    (_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end('<a id="owner" href="' + httpsOrigin + '/archive">Open private archive</a>');
    },
  );
  const externalPort = await listen(external);
  proxy.on("request", (request, response) => {
    if (!app) {
      response.writeHead(503);
      response.end();
      return;
    }
    const forwarded = httpRequest(
      {
        host: "127.0.0.1",
        port: (app.server.address() as { port: number }).port,
        path: request.url,
        method: request.method,
        headers: request.headers,
      },
      (result) => {
        response.writeHead(result.statusCode ?? 500, result.headers);
        result.on("error", () => response.destroy());
        result.pipe(response);
      },
    );
    // Restart tests deliberately close the upstream with live preview requests.
    // Treat their socket resets as proxy failures, not uncaught process errors.
    forwarded.on("error", () => {
      if (!response.headersSent) response.writeHead(503);
      response.end();
    });
    request.on("error", () => forwarded.destroy());
    response.on("close", () => forwarded.destroy());
    request.pipe(forwarded);
  });
  const boot = async () => {
    store = new NativeStore(join(directory, "data"), true);
    const config = validateConfig({
      version: 1,
      origin: httpsOrigin,
      aliases: [],
      allowLoopbackHttp: false,
    });
    const ui = createNativeUiHandler({ readPage: (offset) => app!.assets.list(offset) });
    app = createNativeApplication({ store, config, ...ui });
    const activeApp = app;
    await new Promise<void>((resolve, reject) =>
      activeApp.server.listen(0, "127.0.0.1", resolve).once("error", reject),
    );
  };
  const stopApp = async () => {
    if (!app || !store) return;
    const activeApp = app;
    const activeStore = store;
    activeApp.dispose();
    await new Promise<void>((resolve) => activeApp.server.close(() => resolve()));
    activeStore.close();
    app = undefined;
    store = undefined;
  };
  let context: BrowserContext | undefined;
  try {
    const bootstrap = new NativeStore(join(directory, "data"), true);
    bootstrap.addUser("owner", "The Owner");
    const publisher = issueToken(bootstrap, "owner", "publisher", "publisher");
    const viewer = issueToken(bootstrap, "owner", "reader", "viewer");
    const alternate = issueToken(bootstrap, "owner", "alternate", "publisher");
    bootstrap.addUser("short-user", "Short Session");
    const shortExpiry = Date.now() + 2 * 60 * 60 * 1000;
    const shortToken = issueToken(bootstrap, "short-user", "short", "viewer", shortExpiry);
    if (
      !("secret" in publisher) ||
      !("secret" in viewer) ||
      !("secret" in alternate) ||
      !("secret" in shortToken)
    )
      throw new Error("token issuance failed");
    bootstrap.close();
    await boot();
    const profile = join(directory, "profile");
    const { chromium } = await import("@playwright/test");
    const capBrowser = await chromium.launch({ headless: true });
    try {
      const capContext = await capBrowser.newContext({ ignoreHTTPSErrors: true });
      const capPage = await capContext.newPage();
      await capPage.goto(`${httpsOrigin}/login`);
      await capPage.locator("#token").fill(shortToken.secret);
      await capPage.getByRole("button", { name: "Sign in" }).click();
      await expect(capPage.getByRole("heading", { name: "Artifact archive" })).toBeVisible();
      const cappedCookie = (await capContext.cookies(httpsOrigin)).find(
        (cookie) => cookie.name === "__Host-shlook_session",
      )!;
      expect(cappedCookie.secure).toBe(true);
      expect(cappedCookie.httpOnly).toBe(true);
      expect(cappedCookie.sameSite).toBe("Lax");
      expect(cappedCookie.expires * 1000).toBeLessThanOrEqual(shortExpiry + 5_000);
      expect(cappedCookie.expires * 1000).toBeGreaterThan(shortExpiry - 5_000);
      await capContext.close();
    } finally {
      await capBrowser.close();
    }
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      ignoreHTTPSErrors: true,
    });
    context.setDefaultTimeout(10_000);
    let forbiddenImportRequests = 0;
    const unbundledAssetUrls: string[] = [];
    context.on("request", (request) => {
      if (request.url() === "https://localhost/no.js") forbiddenImportRequests++;
      if (
        !request.url().includes("/api/assets/") &&
        /\/fixture-bundle\/(?:pixel\.png|style\.css)$/.test(request.url())
      ) {
        unbundledAssetUrls.push(request.url());
      }
    });
    let page: Page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${httpsOrigin}/archive`);
    await expect(page).toHaveURL(/\/login\?/);
    await expect(page.locator('input[type="password"]')).toHaveCount(1);
    await expect(page.getByRole("heading")).toHaveCount(0);
    await expect(page.locator("body")).toHaveText("API token Sign in");
    await expect(page.locator('label[for="token"]')).toBeVisible();
    await page.locator('label[for="token"]').click();
    await expect(page.getByLabel("API token", { exact: true })).toBeFocused();
    await expect(page.locator("#token")).toHaveAccessibleName("API token");
    await page.screenshot({ path: testInfo.outputPath("native-login.png") });
    await page.locator("#token").fill(publisher.secret);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(`${httpsOrigin}/archive`);
    await expect(page.getByRole("heading", { name: "Artifact archive" })).toBeVisible();
    const persistentCookie = (await context.cookies(httpsOrigin)).find(
      (cookie) => cookie.name === "__Host-shlook_session",
    )!;
    expect(persistentCookie.secure).toBe(true);
    expect(persistentCookie.httpOnly).toBe(true);
    expect(persistentCookie.sameSite).toBe("Lax");
    expect(persistentCookie.expires * 1000 - Date.now()).toBeGreaterThan(29 * 86400_000);
    expect(persistentCookie.expires * 1000 - Date.now()).toBeLessThanOrEqual(
      30 * 86400_000 + 5_000,
    );
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual(["shlook-theme"]);
    expect(await page.evaluate(() => localStorage.getItem("shlook-theme"))).toMatch(
      /^(light|dark)$/,
    );
    expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
    const openUpload = async () => {
      if (await page.locator("[data-upload-dialog]").isVisible()) {
        await page.locator("[data-upload-close]").click();
      }
      await page.locator("[data-upload-open]").click();
      await expect(page.locator("input[webkitdirectory], [data-directory-picker]")).toHaveCount(0);
      await expect(page.locator("[data-upload-input]")).not.toHaveAttribute("multiple", /.*/);
      await expect(page.getByText("Static folder", { exact: true })).toHaveCount(0);
    };
    const rowFor = (name: string) =>
      page
        .locator("[data-record]")
        .filter({ has: page.locator(".artifact-name", { hasText: new RegExp(`^${name}$`) }) });
    const inspect = async (name: string) => {
      const row = rowFor(name);
      const id = await row.getAttribute("data-record");
      await row.locator(".row-action [data-inspect]").click();
      return page.locator(`[data-detail="${id}"]`);
    };
    // Bundles remain API/CLI capabilities; the browser uses the original
    // single-file dialog. Seed bundle fixtures through the authenticated API.
    const publishBundle = async (
      name: string,
      files: Array<{ name: string; mimeType: string; buffer: Buffer }>,
    ) => {
      const headers = { Authorization: `Bearer ${publisher.secret}` };
      const created = await context!.request.post(`${httpsOrigin}/api/assets`, {
        headers,
        data: { name },
      });
      expect(created.status()).toBe(201);
      const { asset } = await created.json();
      const manifest: Array<{ path: string; uploadId: string }> = [];
      const put = async (path: string, bytes: Buffer) => {
        const uploaded = await context!.request.put(
          `${httpsOrigin}/api/assets/${asset.id}/files/${path.split("/").map(encodeURIComponent).join("/")}`,
          { headers: { ...headers, "Content-Type": "application/octet-stream" }, data: bytes },
        );
        expect(uploaded.status()).toBe(201);
        manifest.push((await uploaded.json()).file);
      };
      for (const file of files) {
        await put(`fixture-${name}/${file.name}`, file.buffer);
      }
      if (files.every((file) => /\.(?:md|mdx)$/i.test(file.name))) {
        await put(
          "index.html",
          Buffer.from("<!doctype html><p>Directory Markdown is preserved as inert downloads.</p>"),
        );
      }
      const entrypoint = manifest.find((file) => /(?:^|\/)index\.html$/.test(file.path))!.path;
      const finalized = await context!.request.post(
        `${httpsOrigin}/api/assets/${asset.id}/finalize`,
        {
          headers,
          data: { entrypoint, files: manifest },
        },
      );
      expect(finalized.status()).toBe(200);
      await page.reload();
    };
    const uploadSingle = async (name: string, fileName: string, buffer: Buffer) => {
      await openUpload();
      await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
        name: fileName,
        mimeType: "application/octet-stream",
        buffer,
      });
      await page.locator("[data-upload-name]").fill(name);
      await page.locator("[data-upload-submit]").click();
    };
    await publishBundle("bundle", [
      {
        name: "index.html",
        mimeType: "text/html",
        buffer: Buffer.from(
          '<link rel="stylesheet" href="style.css"><h1>bundle-ok</h1><script>document.body.dataset.js="ok"</script><img id="pixel" src="pixel.png">',
        ),
      },
      {
        name: "pixel.png",
        mimeType: "image/png",
        buffer: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pWQAAAAASUVORK5CYII=",
          "base64",
        ),
      },
      {
        name: "style.css",
        mimeType: "text/css",
        buffer: Buffer.from("h1 { color: rgb(1, 2, 3); }"),
      },
      {
        name: "nested/child.html",
        mimeType: "text/html",
        buffer: Buffer.from(
          '<script>window.ran=true;try{parent.document.body.dataset.pwned="yes"}catch{};try{parent.localStorage.setItem("pwned","yes")}catch{};fetch("/api/assets",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}).catch(()=>{});navigator.serviceWorker?.register("/sw.js").catch(()=>{});import("https://localhost/no.js").catch(()=>{})</script><h1>nested-active</h1>',
        ),
      },
    ]);
    await publishBundle("notes", [
      { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Notes\n\nhello") },
    ]);
    const inertDirectoryMarkdown = store!.db
      .prepare(
        "SELECT path FROM asset_files f JOIN assets a ON a.id=f.asset_id WHERE a.name=? AND f.path LIKE 'fixture-notes/%'",
      )
      .get("notes") as { path: string };
    expect(inertDirectoryMarkdown.path).toBe("fixture-notes/notes.md");
    await uploadSingle(
      "single-notes",
      "single.md",
      Buffer.from('# Single note\n\n<img src="https://bad.invalid/x">'),
    );
    await expect(page.locator("[data-upload-result]")).toBeVisible();
    const singleMarkdown = store!.db
      .prepare(
        "SELECT path,object_key AS objectKey FROM asset_files f JOIN assets a ON a.id=f.asset_id WHERE a.name=?",
      )
      .get("single-notes") as { path: string; objectKey: string };
    expect(singleMarkdown.path).toBe("single.md.html");
    expect(
      readFileSync(join(store!.directory, "objects", singleMarkdown.objectKey), "utf8"),
    ).toContain("&lt;img src=");
    const assetsBeforeInvalidMarkdown = (
      store!.db.prepare("SELECT COUNT(*) AS count FROM assets").get() as { count: number }
    ).count;
    await uploadSingle("invalid-utf8", "invalid.md", Buffer.from([0xc3, 0x28]));
    await expect(page.getByText(/Markdown must contain valid UTF-8/)).toBeVisible();
    await uploadSingle("expanded-markdown", "expanded.md", Buffer.alloc(6 * 1024 * 1024, 0x26));
    await expect(page.getByText(/Generated Markdown HTML exceeds 25 MiB/)).toBeVisible();
    await uploadSingle("single-mdx", "unsupported.mdx", Buffer.from("export default 1"));
    await expect(page.getByText(/Single-file MDX is unsupported/)).toBeVisible();
    expect(
      (store!.db.prepare("SELECT COUNT(*) AS count FROM assets").get() as { count: number }).count,
    ).toBe(assetsBeforeInvalidMarkdown);
    await uploadSingle(
      "standalone-pixel",
      "pixel.png",
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pWQAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    await expect(page.locator("[data-upload-result]")).toBeVisible();
    await page.locator("[data-upload-close]").click();
    await page.reload();
    const pixelPanel = await inspect("standalone-pixel");
    await expect(pixelPanel.frameLocator("iframe").locator("img")).toBeVisible();
    await expect
      .poll(() =>
        pixelPanel
          .frameLocator("iframe")
          .locator("img")
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(1);
    await rowFor("standalone-pixel").locator(".row-action [data-inspect]").click();
    await expect(pixelPanel.locator("iframe")).not.toHaveAttribute("src", /.+/);
    await expect(rowFor("bundle")).toBeVisible();
    const bundleId = await page.evaluate(async () => {
      const assets = await (await fetch("/api/assets")).json();
      return assets.assets.find((asset: { name: string }) => asset.name === "bundle").id as string;
    });
    const nestedPath = "fixture-bundle/nested/child.html";
    // A shared deep link must recover through login without sending browser
    // users to a JSON error or discarding the requested path and query.
    const freshContext = await context.browser()!.newContext({ ignoreHTTPSErrors: true });
    try {
      const deepLink = `${httpsOrigin}/assets/${bundleId}/${nestedPath}?from=shared%20link&view=1`;
      const freshPage = await freshContext.newPage();
      await freshPage.goto(deepLink);
      await expect(freshPage).toHaveURL(/\/login\?/);
      expect(new URL(freshPage.url()).searchParams.get("return")).toBe(
        new URL(deepLink).pathname + new URL(deepLink).search,
      );
      await expect(freshPage.getByRole("heading")).toHaveCount(0);
      await expect(freshPage.locator("body")).toHaveText("API token Sign in");
      await expect(freshPage.locator('label[for="token"]')).toBeVisible();
      await freshPage.locator("#token").fill(publisher.secret);
      await freshPage.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(freshPage).toHaveURL(deepLink);
      await expect(freshPage.getByRole("heading", { name: "nested-active" })).toBeVisible();
      expect(freshPage.url()).not.toContain(publisher.secret);
      await freshContext.clearCookies();
      const cliResponse = await freshContext.request.get(deepLink, { maxRedirects: 0 });
      expect(cliResponse.status()).toBe(401);
      expect(cliResponse.headers().location).toBeUndefined();
      const apiResponse = await freshPage.goto(`${httpsOrigin}/api/me`);
      // This navigation originates in an opaque sandboxed artifact, so the
      // existing Fetch Metadata boundary denies it before authentication.
      expect(apiResponse!.status()).toBe(403);
      expect((await freshContext.request.get(`${httpsOrigin}/api/me`)).status()).toBe(401);
      await freshPage.goto(
        `${httpsOrigin}/login?return=${encodeURIComponent("//example.invalid/")}`,
      );
      await freshPage.locator("#token").fill(publisher.secret);
      await freshPage.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(freshPage).toHaveURL(`${httpsOrigin}/`);
      await expect(freshPage.locator(".masthead .wordmark")).toHaveText("shlook");
      await expect(freshPage.locator(".ledger")).toBeVisible();
      await expect(freshPage.getByRole("heading", { name: "Artifact archive" })).toBeVisible();
      await expect(freshPage.locator("[data-visibility-menu]")).toHaveCount(0);
      await expect(freshPage.locator("[data-secret]")).toHaveCount(0);
      await freshPage.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
      if ((await freshPage.locator("html").getAttribute("data-theme")) !== "dark") {
        await freshPage.locator("[data-theme-toggle]").click();
      }
      await freshPage.setViewportSize({ width: 1440, height: 1000 });
      await freshPage.screenshot({
        path: testInfo.outputPath("native-archive-desktop.png"),
        fullPage: true,
      });
      await freshPage.setViewportSize({ width: 390, height: 844 });
      expect(
        await freshPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
      await freshPage.screenshot({
        path: testInfo.outputPath("native-archive-mobile.png"),
        fullPage: true,
      });
      await freshContext.clearCookies();
      await freshPage.getByRole("button", { name: "Log out", exact: true }).click();
      await expect(freshPage).toHaveURL(/\/login\?return=%2F$/);
    } finally {
      await freshContext.close();
    }
    const assertArtifactHeaders = (headers: Record<string, string>) => {
      expect(headers["content-security-policy"]).toContain(
        "sandbox allow-scripts allow-downloads;",
      );
      expect(headers["content-security-policy"]).not.toContain("allow-same-origin");
      expect(headers["content-security-policy"]).toContain("script-src 'unsafe-inline'");
      expect(headers["content-security-policy"]).toContain("connect-src 'none'");
      expect(headers["content-security-policy"]).toContain("worker-src 'none'");
      expect(headers["content-security-policy"]).toContain("frame-src 'none'");
      expect(headers["x-content-type-options"]).toBe("nosniff");
      expect(headers["cache-control"]).toContain("private, no-store");
    };
    const directNested = await context.request.get(
      `${httpsOrigin}/assets/${bundleId}/${nestedPath.split("/").map(encodeURIComponent).join("/")}`,
    );
    expect(directNested.status()).toBe(200);
    assertArtifactHeaders(directNested.headers());
    expect(directNested.headers()["content-type"]).toContain("text/html");
    const redirect = await context.request.get(`${httpsOrigin}/assets/${bundleId}/`, {
      maxRedirects: 0,
    });
    expect(redirect.status()).toBe(302);
    expect(redirect.headers().location).toContain(`/assets/${bundleId}/fixture-bundle/index.html`);
    const latest = await context.request.get(`${httpsOrigin}/assets/${bundleId}/latest`, {
      maxRedirects: 0,
    });
    expect(latest.status()).toBe(302);
    expect(latest.headers().location).toContain(`/assets/${bundleId}/fixture-bundle/index.html`);
    assertArtifactHeaders(
      (await context.request.get(`${httpsOrigin}/assets/${bundleId}/`)).headers(),
    );
    assertArtifactHeaders(
      (await context.request.get(`${httpsOrigin}/assets/${bundleId}/latest`)).headers(),
    );
    const previewNested = await context.request.get(
      `${httpsOrigin}/preview/assets/${bundleId}/${nestedPath.split("/").map(encodeURIComponent).join("/")}`,
    );
    expect(previewNested.status()).toBe(200);
    assertArtifactHeaders(previewNested.headers());
    await page.evaluate(
      (src) => {
        const frame = document.createElement("iframe");
        frame.id = "security-probe";
        frame.setAttribute("sandbox", "allow-scripts");
        frame.src = src;
        document.body.append(frame);
      },
      `/preview/assets/${bundleId}/${nestedPath.split("/").map(encodeURIComponent).join("/")}`,
    );
    await expect(
      page.frameLocator("#security-probe").getByRole("heading", { name: "nested-active" }),
    ).toBeVisible();
    expect(await page.locator("body").getAttribute("data-pwned")).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem("pwned"))).toBeNull();
    const ownerAssetsBefore = (
      store!.db.prepare("SELECT COUNT(*) AS count FROM assets").get() as { count: number }
    ).count;
    const attackPage = await context.newPage();
    const directAttackResponse = await attackPage.goto(
      `${httpsOrigin}/assets/${bundleId}/${nestedPath.split("/").map(encodeURIComponent).join("/")}`,
    );
    assertArtifactHeaders(directAttackResponse!.headers());
    await expect(attackPage.getByRole("heading", { name: "nested-active" })).toBeVisible();
    const isolated = await attackPage.evaluate(() => {
      let storageBlocked = false;
      let cookieBlocked = false;
      try {
        localStorage.setItem("owner-probe", "x");
      } catch {
        storageBlocked = true;
      }
      try {
        void document.cookie;
      } catch {
        cookieBlocked = true;
      }
      return {
        ran: (window as Window & { ran?: boolean }).ran,
        cookieBlocked,
        storageBlocked,
        selfParent: parent === window,
      };
    });
    expect(isolated).toEqual({
      ran: true,
      cookieBlocked: true,
      storageBlocked: true,
      selfParent: true,
    });
    expect(
      (store!.db.prepare("SELECT COUNT(*) AS count FROM assets").get() as { count: number }).count,
    ).toBe(ownerAssetsBefore);
    expect(attackPage.url()).not.toContain(publisher.secret);
    expect(
      await attackPage.evaluate(async () => {
        try {
          await indexedDB.databases();
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);
    expect(await context.serviceWorkers()).toHaveLength(0);
    expect(forbiddenImportRequests).toBe(0);
    expect(unbundledAssetUrls).toEqual([]);
    await attackPage.close();
    await page.locator("#security-probe").evaluate((frame) => frame.remove());
    const externalPage = await context.newPage();
    await externalPage.goto(`https://localhost:${externalPort}/`);
    const foreignFrameResponse = externalPage.waitForResponse(
      (response) => response.url() === `${httpsOrigin}/archive`,
      { timeout: 5_000 },
    );
    await externalPage.evaluate((target) => {
      const iframe = document.createElement("iframe");
      iframe.src = `${target}/archive`;
      document.body.append(iframe);
    }, httpsOrigin);
    expect((await foreignFrameResponse).status()).toBe(403);
    const foreignApiFrame = externalPage.waitForResponse(
      (response) => response.url() === `${httpsOrigin}/api/me`,
      { timeout: 5_000 },
    );
    await externalPage.evaluate((target) => {
      const iframe = document.createElement("iframe");
      iframe.src = `${target}/api/me`;
      document.body.append(iframe);
    }, httpsOrigin);
    expect((await foreignApiFrame).status()).toBe(403);
    const foreignMutation = externalPage.waitForResponse(
      (response) =>
        response.url() === `${httpsOrigin}/api/assets` && response.request().method() === "POST",
      { timeout: 5_000 },
    );
    await externalPage.evaluate((target) => {
      const frame = document.createElement("iframe");
      frame.name = "cross-site-mutation";
      const form = document.createElement("form");
      form.method = "POST";
      form.target = frame.name;
      form.action = `${target}/api/assets`;
      const name = document.createElement("input");
      name.name = "name";
      name.value = "cross-site-mutation";
      form.append(name);
      document.body.append(frame, form);
      form.submit();
    }, httpsOrigin);
    expect((await foreignMutation).status()).toBe(403);
    expect(
      (
        store!.db
          .prepare("SELECT COUNT(*) AS count FROM assets WHERE name='cross-site-mutation'")
          .get() as { count: number }
      ).count,
    ).toBe(0);
    await externalPage.evaluate(
      ({ target, id }) => {
        const link = document.createElement("a");
        link.id = "artifact";
        link.href = `${target}/assets/${id}/`;
        link.textContent = "Open artifact";
        document.body.append(link);
      },
      { target: httpsOrigin, id: bundleId },
    );
    await externalPage.getByRole("link", { name: "Open artifact" }).click();
    await expect(externalPage.getByRole("heading", { name: "bundle-ok" })).toBeVisible();
    await externalPage.close();
    await page.goto(`https://localhost:${externalPort}/`);
    await page.getByRole("link", { name: "Open private archive" }).click();
    await expect(page.getByRole("heading", { name: "Artifact archive" })).toBeVisible();
    await expect(page).toHaveURL(`${httpsOrigin}/archive`);
    await publishBundle("attack", [
      {
        name: "index.html",
        mimeType: "text/html",
        buffer: Buffer.from(
          '<script>try{parent.document.body.dataset.pwned="yes"}catch(e){};try{parent.localStorage.setItem("pwned","yes")}catch(e){}</script><h1>contained</h1>',
        ),
      },
    ]);
    const attackPanel = await inspect("attack");
    await expect(
      attackPanel.frameLocator("iframe").getByRole("heading", { name: "contained" }),
    ).toBeVisible();
    expect(await page.locator("body").getAttribute("data-pwned")).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem("pwned"))).toBeNull();
    await rowFor("attack").locator(".row-action [data-inspect]").click();
    await expect(attackPanel.locator("iframe")).not.toHaveAttribute("src", /.+/);
    const bundlePanel = await inspect("bundle");
    await expect(bundlePanel.locator("iframe")).toHaveAttribute("src", /preview/);
    const artifact = bundlePanel.frameLocator("iframe");
    await expect(artifact.getByRole("heading", { name: "bundle-ok" })).toBeVisible();
    await expect.poll(() => artifact.locator("body").getAttribute("data-js")).toBe("ok");
    await expect
      .poll(() =>
        artifact.locator("#pixel").evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(1);
    expect(
      await artifact
        .getByRole("heading", { name: "bundle-ok" })
        .evaluate((heading) => getComputedStyle(heading).color),
    ).toBe("rgb(1, 2, 3)");
    expect(await bundlePanel.locator("iframe").getAttribute("sandbox")).toBe(
      "allow-scripts allow-downloads",
    );
    await rowFor("bundle").locator(".row-action [data-inspect]").click();
    await page.locator("input[data-search]").fill("single-notes");
    await expect(rowFor("single-notes")).toBeVisible();
    await expect(rowFor("bundle")).toBeHidden();
    await page.locator("input[data-search]").fill("");
    const previousTheme = await page.locator("html").getAttribute("data-theme");
    await page.locator("[data-theme-toggle]").click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      previousTheme === "dark" ? "light" : "dark",
    );
    const notesPanel = await inspect("single-notes");
    await notesPanel.locator("[data-hard-expiry]").fill("2030-01-02T03:04");
    await notesPanel.locator("[data-expiry]").click();
    await Promise.all([
      page.waitForEvent("load"),
      page.locator("[data-action-confirm-submit]").click(),
    ]);
    await expect
      .poll(
        () =>
          (
            store!.db
              .prepare("SELECT hard_expires_at AS expiry FROM assets WHERE name='single-notes'")
              .get() as { expiry: string | null }
          ).expiry,
      )
      .not.toBeNull();
    await inspect("single-notes");
    await notesPanel.locator("[data-request-delete]").click();
    await page.locator("[data-confirm]:not([hidden]) [data-delete]").click();
    await expect(rowFor("single-notes")).toHaveCount(0);
    await page.locator("[data-select-toggle]").click();
    await rowFor("standalone-pixel").locator("[data-select-item]").check();
    await page.locator("[data-batch-delete]").click();
    await page.locator("[data-action-confirm-submit]").click();
    await expect(rowFor("standalone-pixel")).toHaveCount(0);
    await context.close();
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      ignoreHTTPSErrors: true,
    });
    page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${httpsOrigin}/archive`);
    await expect(page.getByRole("heading", { name: "Artifact archive" })).toBeVisible();
    await stopApp();
    await boot();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Artifact archive" })).toBeVisible();
    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.locator("#token").fill(viewer.secret);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Artifact archive" })).toBeVisible();
    await expect(page.locator("[data-upload-open]")).toHaveCount(0);
    await expect(page.locator("[data-request-delete]")).toHaveCount(0);
    const cookieValue = (await context.cookies(httpsOrigin)).find(
      (cookie) => cookie.name === "__Host-shlook_session",
    )!.value;
    const sessionHash = createHash("sha256").update(cookieValue).digest("hex");
    const getLastSeen = () =>
      (
        store!.db
          .prepare("SELECT last_seen AS lastSeen FROM sessions WHERE session_hash=?")
          .get(sessionHash) as { lastSeen: number }
      ).lastSeen;
    const csrf = await page.evaluate(
      async () => (await (await fetch("/api/session")).json()).csrfToken as string,
    );
    const renewedLastSeen = getLastSeen();
    const deniedRequests = await page.evaluate(async (csrfToken) => {
      const bad = await fetch("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shlook-CSRF": "bad" },
        body: JSON.stringify({ name: "bad" }),
      });
      const role = await fetch("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shlook-CSRF": csrfToken },
        body: JSON.stringify({ name: "forbidden" }),
      });
      const missing = await fetch("/does-not-exist");
      return [bad.status, role.status, missing.status];
    }, csrf);
    expect(deniedRequests).toEqual([403, 403, 404]);
    expect(getLastSeen()).toBe(renewedLastSeen);
    store!.revokeToken(viewer.id);
    await page.reload();
    await expect(page).toHaveURL(/\/login/);
    expect(
      (
        await page.request.get(`${httpsOrigin}/health`, {
          headers: { Authorization: `Bearer ${alternate.secret}` },
        })
      ).status(),
    ).toBe(200);
    store!.disableUser("owner");
    expect(
      (
        await page.request.get(`${httpsOrigin}/health`, {
          headers: { Authorization: `Bearer ${alternate.secret}` },
        })
      ).status(),
    ).toBe(401);
    await context.close();
    context = undefined;
    await stopApp();
  } finally {
    if (context) await context.close().catch(() => {});
    if (app && store) await stopApp().catch(() => {});
    await close(proxy).catch(() => {});
    await close(external).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});
