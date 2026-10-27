import { expect, test, type Page } from "@playwright/test";
import { ownerClientScript } from "../../src/ui/client-script.ts";
import { ownerDocument } from "../../src/ui/render.ts";
import { ownerStyles } from "../../src/ui/styles.ts";
import { ownerCapabilities } from "../../src/ui/options.ts";
import { nativeRequestScript, nativePreviewScript } from "../../src/native/ui/transport.ts";
import { nativeUploadScript } from "../../src/native/ui/upload.ts";
import type { OwnerAsset } from "../../src/ui/types.ts";

const origin = "https://archive.example";
const interval = 120_000;
type Mode = "cloudflare" | "native-publisher" | "native-viewer";
const asset = (index: number): OwnerAsset => ({
  id: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
  name: `keep-${index}`,
  description: null,
  visibility: "private",
  has_secret: 0,
  secret_url: null,
  share_expires_at: null,
  hard_expires_at: null,
  created_at: "2026-10-26T18:00:00.000Z",
  updated_at: "2026-10-26T18:00:00.000Z",
});

async function fixture(page: Page, mode: Mode) {
  const state = {
    assets: [asset(1)],
    polls: [] as string[],
    status: 200,
    holdNext: false,
    release: undefined as (() => void) | undefined,
    aborted: 0,
  };
  const native = mode !== "cloudflare";
  const publisher = mode !== "native-viewer";
  // Playwright deliberately enables Chromium focus emulation for every page.
  // Control activity explicitly so visibility/focus branches remain deterministic.
  await page.addInitScript(`
    const activity = { visible: true, focused: true };
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => activity.visible ? 'visible' : 'hidden' });
    document.hasFocus = () => activity.focused;
    globalThis.setArchiveActivity = (next) => {
      Object.assign(activity, next);
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event(activity.focused ? 'focus' : 'blur'));
    };
  `);
  await page.clock.install({ time: new Date("2026-10-26T20:00:00.000Z") });
  await page.clock.pauseAt(new Date("2026-10-26T20:01:00.000Z"));
  await page.emulateMedia({ reducedMotion: "reduce" });
  const render = (url: URL) =>
    ownerDocument({
      assets: state.assets,
      hasMore: false,
      ...(native ? {} : { total: state.assets.length }),
      offset: Number(url.searchParams.get("offset") ?? 0),
      ownerOrigin: origin,
      privateOrigin: origin,
      publicOrigin: origin,
      nonce: "refresh-fixture",
      styles: ownerStyles(),
      script: native
        ? ownerClientScript({
            requestScript: nativeRequestScript(),
            uploadScript: nativeUploadScript(),
            previewScript: nativePreviewScript(),
          })
        : ownerClientScript(),
      capabilities: native
        ? {
            ...ownerCapabilities,
            publish: publisher,
            delete: publisher,
            hardExpiry: publisher,
            sharing: false,
            directories: false,
            resolvePreviewEntrypoint: true,
          }
        : ownerCapabilities,
    });
  page.on("requestfailed", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/archive" || path === "/") state.aborted++;
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin && (url.pathname === "/archive" || url.pathname === "/")) {
      const passive = !request.isNavigationRequest();
      const status = passive ? state.status : 200;
      const body = render(url);
      if (passive) {
        state.polls.push(url.pathname + url.search);
        if (state.holdNext) {
          state.holdNext = false;
          await new Promise<void>((resolve) => {
            state.release = resolve;
          });
        }
      }
      try {
        await route.fulfill({ status, contentType: "text/html", body });
      } catch {
        if (!request.failure()) throw new Error("Unexpected fixture response failure");
      }
    } else if (url.pathname.startsWith("/preview/")) {
      await route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="88"><rect width="160" height="88" fill="#b8ad99"/></svg>',
      });
    } else if (url.pathname.startsWith("/api/assets/")) {
      await route.fulfill({ json: { asset: { entrypoint: "index.html" } } });
    } else {
      await route.abort();
    }
  });
  await page.goto(origin + "/archive?offset=24&fixture=keep");
  await expect(page.locator(".artifact-name")).toHaveText("keep-1");
  return state;
}

async function activity(page: Page, visible: boolean, focused: boolean) {
  await page.evaluate(
    (state) => {
      (
        globalThis as typeof globalThis & { setArchiveActivity: (value: typeof state) => void }
      ).setArchiveActivity(state);
    },
    { visible, focused },
  );
  await page.clock.runFor(100);
}

for (const mode of ["cloudflare", "native-publisher", "native-viewer"] as const) {
  test(`${mode}: poll only while active and refresh immediately on return`, async ({ page }) => {
    const state = await fixture(page, mode);
    await page.locator("input[data-search]").fill("keep");
    if (mode === "cloudflare") {
      await page.locator("[data-filter-menu] [data-menu-button]").click();
      await page.locator('[data-filter-option="private"]').click();
    }
    if (mode !== "native-viewer") {
      await page.locator("[data-select-toggle]").click();
      await page.locator("[data-select-item]").check();
    }
    state.assets.unshift(asset(2));
    await page.clock.runFor(interval - 1);
    expect(state.polls).toEqual([]);
    await page.clock.runFor(1);
    await expect(page.locator(".artifact-name")).toHaveCount(2);
    expect(state.polls).toEqual(["/archive?offset=24&fixture=keep"]);
    await expect(page.locator("input[data-search]")).toHaveValue("keep");
    if (mode === "cloudflare")
      await expect(page.locator("[data-filter-menu]")).toHaveAttribute("data-value", "private");
    if (mode !== "native-viewer") {
      await expect(page.locator(`[data-record="${asset(1).id}"] [data-select-item]`)).toBeChecked();
      await expect(page.locator("body")).toHaveClass(/selection-mode/);
    }
    const url = page.url();
    await activity(page, false, false);
    state.assets.unshift(asset(3));
    await page.clock.fastForward(interval * 5);
    expect(state.polls).toHaveLength(1);
    await page.bringToFront();
    await activity(page, true, true);
    await expect(page.locator(".artifact-name")).toHaveCount(3);
    await page.clock.runFor(1000);
    expect(state.polls).toHaveLength(2);
    await activity(page, true, false); // Visible but in an unfocused browser window.
    state.assets.unshift(asset(4));
    await page.clock.fastForward(interval * 5);
    expect(state.polls).toHaveLength(2);
    await activity(page, true, true);
    await expect(page.locator(".artifact-name")).toHaveCount(4);
    await page.clock.runFor(1000);
    expect(state.polls).toHaveLength(3);
    expect(page.url()).toBe(url);
  });

  test(`${mode}: cancel stale background requests, including authentication failures`, async ({
    page,
  }) => {
    const state = await fixture(page, mode);
    state.status = 401;
    state.holdNext = true;
    await page.clock.runFor(interval);
    await expect.poll(() => state.polls.length).toBe(1);
    await activity(page, false, false);
    await expect.poll(() => state.aborted).toBe(1);
    state.status = 200;
    state.assets.unshift(asset(2));
    state.release!();
    await page.clock.fastForward(interval * 5);
    await expect(page.locator(".artifact-name")).toHaveText("keep-1");
    expect(state.polls).toHaveLength(1);
    await activity(page, true, true);
    await expect(page.locator(".artifact-name")).toHaveCount(2);
    expect(state.polls).toHaveLength(2);
    expect(new URL(page.url()).pathname).toBe("/archive");
  });

  test(`${mode}: retain drafts and quietly retry failures`, async ({ page }) => {
    const state = await fixture(page, mode);
    if (mode !== "native-viewer") {
      await page.locator(".row-action [data-inspect]").click();
      const expiry = page.locator("[data-detail] [data-hard-expiry]");
      const baseline = await expiry.inputValue();
      await expiry.fill("2032-10-28T18:06");
      state.assets.unshift(asset(2));
      await page.clock.runFor(interval);
      expect(state.polls).toEqual([]);
      await expect(expiry).toHaveValue("2032-10-28T18:06");
      await page.locator(".row-action [data-inspect]").click();
      await activity(page, false, false);
      await activity(page, true, true);
      expect(state.polls).toEqual([]); // Collapsing the inspector did not discard its draft.
      await page.locator(".row-action [data-inspect]").click();
      await expect(expiry).toHaveValue("2032-10-28T18:06");
      await expiry.fill(baseline);
      await page.locator(".row-action [data-inspect]").click();
      await page.clock.runFor(100);
      await expect(page.locator(".artifact-name")).toHaveCount(2);
      await page.locator("[data-upload-open]").click();
      await page.locator("[data-upload-input]").setInputFiles({
        name: "draft.html",
        mimeType: "text/html",
        buffer: Buffer.from("<h1>Draft</h1>"),
      });
      await page.locator("[data-upload-name]").fill("Unpublished draft");
      state.assets.unshift(asset(3));
      const before = state.polls.length;
      await page.clock.runFor(interval);
      expect(state.polls).toHaveLength(before);
      await expect(page.locator("[data-upload-name]")).toHaveValue("Unpublished draft");
      await page.locator("[data-upload-close]").click();
      await page.clock.runFor(100);
      await expect(page.locator(".artifact-name")).toHaveCount(3);
    }
    const oldCount = state.assets.length;
    const oldStatus = await page.locator("[data-toast]").textContent();
    state.assets.unshift(asset(4));
    state.status = 500;
    await page.clock.runFor(interval);
    await expect(page.locator(".artifact-name")).toHaveCount(oldCount);
    await expect(page.locator("[data-toast]")).toHaveText(oldStatus ?? "");
    state.status = 200;
    await page.clock.runFor(interval);
    await expect(page.locator(".artifact-name")).toHaveCount(oldCount + 1);
  });
}
