declare namespace Cloudflare {
  interface Env {
    ASSETS: R2Bucket;
    DB: D1Database;
    SHLOOK_OWNER_EMAIL: string;
    SHLOOK_OWNER_ORIGIN: string;
    SHLOOK_PRIVATE_ORIGIN: string;
    SHLOOK_PUBLIC_ORIGIN: string;
    SHLOOK_SHARE_ORIGIN: string;
    SHLOOK_SECRET_ENCRYPTION_KEY: string;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
