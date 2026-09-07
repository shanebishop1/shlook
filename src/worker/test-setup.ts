import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, vi } from "vitest";

export function setupWorkerTestDatabase(): void {
  vi.setConfig({ testTimeout: 15_000 });
  beforeEach(async () => {
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });
}
