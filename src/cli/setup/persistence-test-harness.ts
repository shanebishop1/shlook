import { vi } from "vitest";

import type { SetupPersistence } from "../../cli-setup.ts";

export function persistence(overrides: Partial<SetupPersistence> = {}): SetupPersistence {
  return {
    saveIntent: vi.fn(async () => undefined),
    saveResource: vi.fn(async () => undefined),
    beginServiceTokenRotation: vi.fn(async () => undefined),
    saveServiceToken: vi.fn(async () => undefined),
    ...overrides,
  };
}
