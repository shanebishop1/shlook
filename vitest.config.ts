import path from "node:path";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./test/wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SHLOOK_OWNER_ORIGIN: "https://owner.example.com",
            SHLOOK_PRIVATE_ORIGIN: "https://private.example.com",
            SHLOOK_PUBLIC_ORIGIN: "https://public.example.com",
            SHLOOK_SHARE_ORIGIN: "https://share.example.com",
            SHLOOK_OWNER_EMAIL: "owner@example.com",
            SHLOOK_SECRET_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          },
        },
      }),
    ],
  };
});
