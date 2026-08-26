declare namespace Cloudflare {
  interface Env {
    ASSETS: R2Bucket;
    DB: D1Database;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
