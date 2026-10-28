import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { compileNativeBundle, NATIVE_BUNDLE_CSP } from "../../src/native/bundle.ts";
import { ownerDocument } from "../../src/ui/render.ts";

const markdown = "# Synthetic meeting\n\n- Alice: café & <review>\n";
const filename = "meeting-transcript.md";
const html = `<!doctype html><title>Synthetic meeting</title>
  <button type="button">Download Markdown</button>
  <script>
    document.querySelector('button').addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([${JSON.stringify(markdown)}], { type: 'text/markdown;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = '${filename}';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  </script>`;

for (const surface of ["hosted", "preview"] as const) {
  test(`${surface} sandbox saves generated Markdown without granting origin access`, async ({
    page,
  }, testInfo) => {
    const compiled = compileNativeBundle(new Map([["index.html", html]]), "index.html").get(
      "index.html",
    )!;
    // Use the actual archive iframe policy, not a duplicate hard-coded sandbox.
    const archive = ownerDocument({
      assets: [
        {
          id: "synthetic-meeting",
          name: "Synthetic meeting",
          description: null,
          visibility: "private",
          has_secret: 0,
          secret_url: null,
          share_expires_at: null,
          hard_expires_at: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
      hasMore: false,
      offset: 0,
      ownerOrigin: "",
      privateOrigin: "",
      publicOrigin: "",
      nonce: "synthetic",
      styles: "",
      script: "",
    });
    const frame = archive.match(/<iframe\b[^>]*><\/iframe>/)?.[0];
    expect(frame).toBeDefined();
    const preview = frame!
      .replace("<iframe ", '<iframe src="/hosted" ')
      .replace(" hidden", "")
      .replace(' loading="lazy"', "");
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      if (request.url === "/hosted") {
        response.setHeader("Content-Security-Policy", NATIVE_BUNDLE_CSP);
        response.end(compiled);
      } else response.end(preview);
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;
      await page.goto(`http://127.0.0.1:${port}/${surface}`);
      const artifact = surface === "hosted" ? page.mainFrame() : page.frames()[1];
      await expect(artifact.getByRole("button", { name: "Download Markdown" })).toBeVisible();
      expect(
        await artifact.evaluate(() => {
          try {
            localStorage.getItem("owner-secret");
            return false;
          } catch {
            return true;
          }
        }),
      ).toBe(true);
      if (surface === "preview") {
        expect(
          await artifact.evaluate(() => {
            try {
              return parent.document === document;
            } catch {
              return "blocked";
            }
          }),
        ).toBe("blocked");
      }
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 5000 }),
        artifact.getByRole("button", { name: "Download Markdown" }).click(),
      ]);
      expect(download.suggestedFilename()).toBe(filename);
      const saved = testInfo.outputPath(filename);
      await download.saveAs(saved);
      expect(await download.failure()).toBeNull();
      expect(readFileSync(saved)).toEqual(Buffer.from(markdown));
    } finally {
      try {
        await page.goto("about:blank");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });
}
