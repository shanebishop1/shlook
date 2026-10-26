import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { request as httpRequest, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { NativeStore } from "../../src/native/store.ts";
import { issueToken } from "../../src/native/admin.ts";
import { createNativeApplication } from "../../src/native/router.ts";
import { createNativeUiHandler } from "../../src/native/ui/index.ts";
import { validateConfig } from "../../src/native/config.ts";
import { renderSafeMarkdown } from "../../src/markdown.ts";

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

test("native UI login, uploads, persistent sessions, revocation, and viewer policy over HTTPS", async () => {
  test.setTimeout(60_000);
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
        result.pipe(response);
      },
    );
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
    const ui = createNativeUiHandler();
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
      await expect(capPage.getByRole("heading", { name: "Archive" })).toBeVisible();
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
    await page.locator("#token").fill(publisher.secret);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(`${httpsOrigin}/archive`);
    await expect(page.getByRole("heading", { name: "Archive" })).toBeVisible();
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
    expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
    const markdownSample = "# Shared renderer\n\n<script>bad()</script>\n\n- safe";
    expect(
      await page.evaluate(
        (source) =>
          (
            window as Window & { renderSafeMarkdown?: (value: string) => string }
          ).renderSafeMarkdown?.(source),
        markdownSample,
      ),
    ).toBe(renderSafeMarkdown(markdownSample));
    const upload = async (
      name: string,
      files: Array<{ name: string; mimeType: string; buffer: Buffer }>,
    ) => {
      await page.getByLabel("Name", { exact: true }).fill(name);
      const folder = join(directory, `fixture-${name}`);
      mkdirSync(folder);
      for (const file of files) {
        const path = join(folder, file.name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, file.buffer);
      }
      await page.locator("input[webkitdirectory]").setInputFiles(folder);
      await page.locator("#upload-status").evaluate((status) => (status.textContent = ""));
      await page.getByRole("button", { name: "Upload and publish" }).click();
      await expect(page.locator("#upload-status")).not.toHaveText("");
      await expect(page.locator("#upload-status")).toHaveText("Published successfully");
    };
    const uploadSingle = async (name: string, fileName: string, buffer: Buffer) => {
      await page.getByLabel("Name", { exact: true }).fill(name);
      await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
        name: fileName,
        mimeType: "application/octet-stream",
        buffer,
      });
      await page.locator("#upload-status").evaluate((status) => (status.textContent = ""));
      await page.getByRole("button", { name: "Upload and publish" }).click();
    };
    await upload("bundle", [
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
    await upload("notes", [
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
    await expect(page.locator("#upload-status")).toHaveText("Published successfully");
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
    await page
      .locator('article:has(h2:text("standalone-pixel"))')
      .getByRole("button", { name: "Preview" })
      .click();
    await expect(page.frameLocator("#preview").locator("img")).toBeVisible();
    await expect
      .poll(() =>
        page
          .frameLocator("#preview")
          .locator("img")
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(1);
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.locator("#preview")).not.toHaveAttribute("src", /.+/);
    await expect(page.getByText("bundle", { exact: true })).toBeVisible();
    const bundleId = await page.evaluate(async () => {
      const assets = await (await fetch("/api/assets")).json();
      return assets.assets.find((asset: { name: string }) => asset.name === "bundle").id as string;
    });
    const nestedPath = "fixture-bundle/nested/child.html";
    const assertArtifactHeaders = (headers: Record<string, string>) => {
      expect(headers["content-security-policy"]).toContain("sandbox allow-scripts");
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
    await page.locator("#preview").evaluate(
      (frame: HTMLIFrameElement, src) => {
        frame.setAttribute("src", src);
        frame.closest("#viewer")!.removeAttribute("hidden");
      },
      `/preview/assets/${bundleId}/${nestedPath.split("/").map(encodeURIComponent).join("/")}`,
    );
    await expect(
      page.frameLocator("#preview").getByRole("heading", { name: "nested-active" }),
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
    await page.getByRole("button", { name: "Close" }).click();
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
    await expect(page.getByRole("heading", { name: "Archive" })).toBeVisible();
    await expect(page).toHaveURL(`${httpsOrigin}/archive`);
    await upload("attack", [
      {
        name: "index.html",
        mimeType: "text/html",
        buffer: Buffer.from(
          '<script>try{parent.document.body.dataset.pwned="yes"}catch(e){};try{parent.localStorage.setItem("pwned","yes")}catch(e){}</script><h1>contained</h1>',
        ),
      },
    ]);
    await page
      .locator('article:has(h2:text("attack"))')
      .getByRole("button", { name: "Preview" })
      .click();
    await expect(
      page.frameLocator("iframe").getByRole("heading", { name: "contained" }),
    ).toBeVisible();
    expect(await page.locator("body").getAttribute("data-pwned")).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem("pwned"))).toBeNull();
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.locator("#preview")).toHaveCount(1);
    const previewButton = page
      .locator('article:has(h2:text("bundle"))')
      .getByRole("button", { name: "Preview" });
    await previewButton.click();
    await expect(page.locator("#preview")).toHaveAttribute("src", /preview/);
    const artifact = page.frameLocator("iframe");
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
    expect(await page.locator("iframe").getAttribute("sandbox")).toBe("allow-scripts");
    await context.close();
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      ignoreHTTPSErrors: true,
    });
    page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${httpsOrigin}/archive`);
    await expect(page.getByRole("heading", { name: "Archive" })).toBeVisible();
    await stopApp();
    await boot();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Archive" })).toBeVisible();
    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.locator("#token").fill(viewer.secret);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Archive" })).toBeVisible();
    await expect(page.locator("#upload-panel")).toBeHidden();
    expect(await page.getByRole("button", { name: "Delete" }).count()).toBe(0);
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
