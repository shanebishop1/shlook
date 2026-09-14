import { expect, test, type Locator, type Page } from "@playwright/test";

import { ownerClientScript } from "../../src/ui/client-script.ts";
import { ownerDocument } from "../../src/ui/render.ts";
import { ownerStyles } from "../../src/ui/styles.ts";
import type { OwnerAsset } from "../../src/ui/types.ts";

const origin = "https://owner.example.com";
const assets: OwnerAsset[] = (["secret_link", "private", "public"] as const).map(
  (visibility, index) => ({
    id: `${index + 1}1111111-1111-4111-8111-111111111111`,
    name: index === 0 ? "Screenshot 2026-09-14 at 12.04.38 PM" : "Artifact".repeat(10),
    description: "A responsive layout fixture with a longer artifact description.",
    visibility,
    has_secret: visibility === "secret_link" ? 1 : 0,
    secret_url: visibility === "secret_link" ? "https://share.example.com/fixture" : null,
    share_expires_at: null,
    hard_expires_at: "2030-01-02T03:04:00.000Z",
    created_at: "2026-09-14T12:04:38.000Z",
    updated_at: "2026-09-14T12:04:38.000Z",
  }),
);

async function openArchive(page: Page) {
  const html = ownerDocument({
    assets,
    hasMore: false,
    total: assets.length,
    offset: 0,
    ownerOrigin: origin,
    privateOrigin: "https://private.example.com",
    publicOrigin: "https://public.example.com",
    nonce: "layout-fixture",
    styles: ownerStyles(),
    script: ownerClientScript(),
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname === "/") {
      await route.fulfill({ contentType: "text/html", body: html });
    } else if (url.pathname.startsWith("/preview/")) {
      await route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="88"><rect width="160" height="88" fill="#b8ad99"/></svg>',
      });
    } else {
      await route.abort();
    }
  });
  await page.goto(origin);
}

async function box(locator: Locator) {
  const result = await locator.boundingBox();
  expect(result).not.toBeNull();
  return result!;
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [320, 375, 520, 640, 768, 900, 901, 960, 1024, 1080, 1081, 1180, 1440]) {
    test(`archive controls fit at ${width}px in ${theme} mode`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await openArchive(page);

      const toolbar = await box(page.locator(".toolbar"));
      const pencil = await box(page.locator("[data-select-toggle]"));
      const filter = await box(page.locator(".filter-wrap"));
      expect(pencil.x).toBeGreaterThanOrEqual(filter.x + filter.width + 7);
      expect(pencil.x + pencil.width).toBeCloseTo(toolbar.x + toolbar.width, 0);
      const ledger = await box(page.locator(".ledger"));
      const table = await box(page.locator("table"));
      expect(table.width).toBeLessThanOrEqual(ledger.width + 1);
      expect(table.x + table.width).toBeLessThanOrEqual(width);

      for (const row of await page.locator(".artifact-row").all()) {
        const trigger = row.locator("[data-menu-button]");
        const select = await box(trigger);
        const cell = await box(row.locator("td").nth(2));
        const label = await box(trigger.locator("[data-menu-label]"));
        const arrow = await box(trigger.locator("svg"));
        expect(select.x).toBeGreaterThanOrEqual(cell.x);
        expect(select.x + select.width).toBeLessThanOrEqual(cell.x + cell.width - 7);
        expect(label.height).toBeLessThan(18);
        expect(label.x + label.width).toBeLessThanOrEqual(arrow.x - 7);
        if (width > 900) expect(select.width).toBe(108);
        const copy = row.locator("[data-copy-row]");
        const inspect = row.locator(".row-action [data-inspect]");
        const inspectBox = await box(inspect);
        if ((await row.getAttribute("data-visibility")) === "private") {
          await expect(copy).toBeHidden();
        } else {
          const copyBox = await box(copy);
          expect(copyBox.width).toBeCloseTo(inspectBox.width, 0);
          expect(inspectBox.x - copyBox.x - copyBox.width).toBeGreaterThanOrEqual(5);
          if (width > 520 && width <= 900) {
            expect(copyBox.x).toBeCloseTo(select.x, 0);
            expect(inspectBox.x + inspectBox.width).toBeCloseTo(select.x + select.width, 0);
          }
        }
        if (width <= 520) {
          expect(inspectBox.y).toBeCloseTo(select.y, 0);
          expect(inspectBox.x).toBeGreaterThan(select.x + select.width);
        }
        await trigger.click();
        await expect(
          row.locator('[role="option"]').filter({ hasText: "Secret link" }),
        ).toBeVisible();
        const menu = await box(row.locator("[data-menu-list]"));
        expect(menu.x).toBeGreaterThanOrEqual(0);
        expect(menu.x + menu.width).toBeLessThanOrEqual(width);
        await page.keyboard.press("Escape");
        await expect(trigger).toBeFocused();
      }

      if ([375, 768, 1024, 1440].includes(width)) {
        await page.screenshot({ path: testInfo.outputPath("archive.png"), fullPage: true });
      }
    });
  }

  for (const width of [375, 900]) {
    test(`upload copied result uses a neutral surface at ${width}px in ${theme} mode`, async ({
      page,
      context,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
      await openArchive(page);
      await page.route(`${origin}/api/assets**`, async (route) => {
        const path = new URL(route.request().url()).pathname;
        await route.fulfill({
          json:
            path === "/api/assets"
              ? { asset: { id: assets[0].id } }
              : path.includes("/files/")
                ? { file: { path: "fixture.html", uploadId: "fixture-upload" } }
                : {},
        });
      });
      await page.locator("[data-upload-open]").click();
      await page.locator("[data-upload-input]").setInputFiles({
        name: "fixture.html",
        mimeType: "text/html",
        buffer: Buffer.from("<!doctype html><title>Layout fixture</title>"),
      });
      await page.locator("[data-upload-submit]").click();
      await expect(page.locator("[data-upload-result]")).toBeVisible();
      await page.locator("[data-upload-copy]").click();
      await expect(page.locator("[data-upload-result-label]")).toHaveText("URL copied.");
      await expect(page.locator("[data-upload-result]")).toHaveCSS(
        "background-color",
        theme === "light" ? "rgb(251, 248, 240)" : "rgb(20, 24, 20)",
      );
      const form = await box(page.locator("[data-upload-form]"));
      const url = await box(page.locator("[data-upload-result-url]"));
      expect(url.x + url.width).toBeLessThan(form.x + form.width);
      await page.screenshot({ path: testInfo.outputPath("upload-result.png") });
    });
  }
}
