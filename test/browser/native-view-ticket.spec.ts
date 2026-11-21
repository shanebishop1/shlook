import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer as createHttpsServer, type Server } from "node:https";
import { NativeStore } from "../../src/native/store.ts";
import { createNativeApplication } from "../../src/native/router.ts";
import { createNativeUiHandler } from "../../src/native/ui/index.ts";
import { validateConfig } from "../../src/native/config.ts";
import { issueViewTicket } from "../../src/native/view-tickets.ts";

const listen = (server: Server) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

test("a cookieless browser opens a ticketed link once and lands on the clean artifact URL", async ({
  browser,
}) => {
  const directory = mkdtempSync(join(tmpdir(), "shlook-view-ticket-"));
  const key = join(directory, "key.pem"),
    cert = join(directory, "cert.pem");
  mkdirSync(join(directory, "data"));
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
  const tls = { key: readFileSync(key), cert: readFileSync(cert) };
  let app: ReturnType<typeof createNativeApplication> | undefined;
  const shlook = createHttpsServer(tls, (request, response) =>
    app!.server.emit("request", request, response),
  );
  const port = await listen(shlook);
  const origin = `https://127.0.0.1:${port}`;
  let ticketedUrl = "";
  // Stands in for Dashfleet: a different HTTPS origin whose page links to the ticketed URL.
  const dashboard = createHttpsServer(tls, (_request, response) => {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
    });
    response.end(
      `<a id="open" href="${ticketedUrl}" target="_blank" rel="noopener noreferrer">artifact</a>`,
    );
  });
  const dashboardOrigin = `https://127.0.0.1:${await listen(dashboard)}`;
  const store = new NativeStore(join(directory, "data"));
  try {
    store.addUser("owner", "Owner");
    const publisher = store.issueToken({ userId: "owner", name: "publisher", role: "publisher" });
    store.addUser("dashfleet", "Dashfleet");
    const viewer = store.issueToken({ userId: "dashfleet", name: "tickets", role: "viewer" });
    const config = validateConfig({ version: 1, origin, aliases: [], allowLoopbackHttp: false });
    const ui = createNativeUiHandler({ readPage: (offset) => app!.assets.list(offset) });
    app = createNativeApplication({ store, config, ...ui });
    const assets = app.assets;
    const identity = {
      user: { id: "owner", displayName: "Owner" },
      role: "publisher" as const,
      tokenId: publisher.id,
    };
    const created = assets.create({ name: "Ticketed" }, identity, () => {});
    const html = "<main id='artifact'>visible through a ticket</main>";
    const uploaded = await assets.upload(
      created.id,
      "index.html",
      (async function* () {
        yield Buffer.from(html);
      })(),
      String(Buffer.byteLength(html)),
      () => {},
    );
    assets.finalize(created.id, { entrypoint: "index.html", files: [uploaded] }, () => {});
    const path = `/assets/${created.id}/index.html`;
    ticketedUrl = `${origin}${path}?shlook_ticket=${issueViewTicket(store, viewer.id, path).ticket}`;

    const fresh = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const page = await fresh.newPage();
      await page.goto(dashboardOrigin);
      const [popup] = await Promise.all([page.waitForEvent("popup"), page.click("#open")]);
      await popup.waitForLoadState();
      expect(popup.url()).toBe(`${origin}${path}`);
      await expect(popup.locator("#artifact")).toHaveText("visible through a ticket");
      await popup.reload();
      await expect(popup.locator("#artifact")).toHaveText("visible through a ticket");
      const cookies = await fresh.cookies(`${origin}${path}`);
      expect(cookies.map((cookie) => [cookie.name, cookie.path, cookie.httpOnly])).toEqual([
        ["__Secure-shlook_view", `/assets/${created.id}/`, true],
      ]);
      // The grant does not open the archive.
      await popup.goto(`${origin}/archive`);
      expect(new URL(popup.url()).pathname).toBe("/login");
    } finally {
      await fresh.close();
    }

    const replay = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const page = await replay.newPage();
      await page.goto(ticketedUrl);
      expect(new URL(page.url()).pathname).toBe("/login");
      await expect(page.locator("#artifact")).toHaveCount(0);
      expect(await replay.cookies(`${origin}${path}`)).toEqual([]);
    } finally {
      await replay.close();
    }
  } finally {
    app?.dispose();
    await close(shlook);
    await close(dashboard);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
