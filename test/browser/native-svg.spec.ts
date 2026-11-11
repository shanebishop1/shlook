import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { compileNativeBundle, NATIVE_BUNDLE_CSP, NATIVE_SVG_CSP } from "../../src/native/bundle.ts";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" onload="document.documentElement.dataset.executed='yes'">
  <script>document.documentElement.dataset.executed='yes'; fetch('/leak')</script>
  <image href="/leak"/>
  <rect width="120" height="80" fill="red"/>
</svg>`;

test("inline charts and SVG images render without weakening sandbox isolation", async ({
  page,
}) => {
  const compiled = compileNativeBundle(
    new Map([
      [
        "index.html",
        '<svg width="120" height="80"><defs><linearGradient id="g"><stop stop-color="red"/></linearGradient><rect id="shape" width="120" height="80"/></defs><use href="#shape" fill="url(#g)"/></svg><img src="chart.svg"><img src="data:image/svg+xml;base64,' +
          Buffer.from(svg).toString("base64") +
          '">',
      ],
      ["chart.svg", svg],
    ]),
    "index.html",
  ).get("index.html")!;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    const standalone = request.url === "/chart.svg";
    response.setHeader("Content-Type", standalone ? "image/svg+xml" : "text/html");
    response.setHeader("Content-Security-Policy", standalone ? NATIVE_SVG_CSP : NATIVE_BUNDLE_CSP);
    response.end(standalone ? svg : compiled);
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await page.goto(origin);
    await expect(page.locator("svg")).toBeVisible();
    await expect(page.locator("use")).toHaveAttribute("href", "#shape");
    await expect
      .poll(() =>
        page
          .locator("img")
          .evaluateAll((images) =>
            images.every((image) => (image as HTMLImageElement).naturalWidth === 120),
          ),
      )
      .toBe(true);
    expect(await page.evaluate(() => document.documentElement.dataset.executed)).toBeUndefined();
    expect(
      await page.evaluate(() => {
        try {
          localStorage.getItem("owner-secret");
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);
    await page.goto(`${origin}/chart.svg`);
    await expect(page.locator("rect")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.dataset.executed)).toBeUndefined();
    expect(requests.some((url) => url.includes("/leak"))).toBe(false);
  } finally {
    await page.goto("about:blank");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
