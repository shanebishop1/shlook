import os from "node:os";
import path from "node:path";

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  testMatch: "**/*.spec.ts",
  tsconfig: "./tsconfig.browser.json",
  timeout: 15_000,
  fullyParallel: false,
  workers: 1,
  outputDir: path.join(os.tmpdir(), "shlook-playwright-results"),
  use: {
    browserName: "chromium",
    headless: true,
  },
});
