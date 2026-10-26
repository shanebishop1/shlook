import { expect, test } from "@playwright/test";
import { loginDocument } from "../../src/native/ui/login.ts";

for (const theme of ["light", "dark"] as const) {
  for (const width of [375, 1440]) {
    test(`token label stays visible at ${width}px in ${theme} mode`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme: theme });
      await page.route("https://login.example/login", (route) =>
        route.fulfill({ contentType: "text/html", body: loginDocument("/archive", "fixture") }),
      );
      await page.goto("https://login.example/login");
      const label = page.locator('label[for="token"]');
      const input = page.getByLabel("API token", { exact: true });
      await expect(label).toHaveText("API token");
      await expect(label).toBeVisible();
      await expect(label).toHaveCSS(
        "color",
        theme === "dark" ? "rgb(238, 237, 231)" : "rgb(32, 40, 33)",
      );
      await expect(input).toBeVisible();
      await expect(input).toHaveAttribute("type", "password");
      await label.click();
      await expect(input).toBeFocused();
      await expect(page.getByRole("heading")).toHaveCount(0);
      await expect(page.locator("body")).toHaveText("API token Sign in");
      const field = await input.boundingBox();
      const caption = await label.boundingBox();
      expect(field).not.toBeNull();
      expect(caption).not.toBeNull();
      expect(caption!.y + caption!.height).toBeLessThanOrEqual(field!.y);
      expect(field!.x).toBeGreaterThanOrEqual(24);
      expect(field!.x + field!.width).toBeLessThanOrEqual(width - 24);
      await page.screenshot({ path: testInfo.outputPath("labeled-login.png") });
    });
  }
}
