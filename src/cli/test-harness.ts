import { EventEmitter } from "node:events";

import { vi } from "vitest";

import type { CliDependencies } from "../cli";

export const DEFAULT_ORIGIN = "https://shlook.example.com";
export const DEFAULT_ENV = {
  CF_ACCESS_CLIENT_ID: "test-id",
  CF_ACCESS_CLIENT_SECRET: "test-secret",
  SHLOOK_DOMAIN: "example.com",
};
export const assetId = "11111111-1111-4111-8111-111111111111";
export const uploadId = "22222222-2222-4222-8222-222222222222";
export const storedCredential = {
  domain: "stored.example.com",
  accessClientId: "stored-client-id",
  accessClientSecret: "stored-client-secret",
} as const;

export class SecretInput extends EventEmitter {
  readonly rawModes: boolean[] = [];
  readonly resume = vi.fn(() => {
    this.paused = false;
  });
  readonly pause = vi.fn(() => {
    this.paused = true;
  });
  isRaw: boolean;

  constructor(
    readonly isTTY: boolean,
    private paused: boolean,
    initiallyRaw = false,
  ) {
    super();
    this.isRaw = initiallyRaw;
  }

  isPaused(): boolean {
    return this.paused;
  }

  setRawMode(mode: boolean): void {
    this.rawModes.push(mode);
    this.isRaw = mode;
  }
}

export function secretOutput() {
  const chunks: string[] = [];
  return { chunks, stream: { write: (value: string) => chunks.push(value) } };
}

export function harness(overrides: Partial<CliDependencies> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const dependencies: CliDependencies = {
    cwd: "/repo",
    packageRoot: "/package",
    nodeExecutable: "/node",
    wranglerPath: "/package/node_modules/wrangler/bin/wrangler.js",
    env: DEFAULT_ENV,
    fetch: vi.fn(async () => Response.json({ ok: true })),
    runCommand: vi.fn(async () => ({ code: 0 })),
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    currentUid: () => 1_000,
    parseArguments: (argv) => {
      const positionals: string[] = [];
      const options: Record<string, boolean | string> = {};
      for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (
          ["--json", "--plan", "--apply", "--show-connection-token", "--adopt-existing"].includes(
            value,
          )
        )
          options[
            value === "--show-connection-token"
              ? "showConnectionToken"
              : value === "--adopt-existing"
                ? "adoptExisting"
                : value.slice(2)
          ] = true;
        else if (
          [
            "--entrypoint",
            "--offset",
            "--name",
            "--description",
            "--domain",
            "--owner-email",
            "--account-id",
          ].includes(value)
        )
          options[
            value === "--owner-email"
              ? "ownerEmail"
              : value === "--account-id"
                ? "accountId"
                : value.slice(2)
          ] = argv[++index];
        else positionals.push(value);
      }
      return { positionals, options };
    },
    ...overrides,
  };
  return { dependencies, stdout, stderr };
}

export function simulatedRedirectFetch(
  respond: (input: string | URL | Request, init?: RequestInit) => Promise<Response> | Response,
) {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const implementation = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    const response = await respond(input, init);
    const location = response.headers.get("location");
    if (
      response.status >= 300 &&
      response.status < 400 &&
      init?.redirect !== "manual" &&
      location
    ) {
      return implementation(location, init);
    }
    return response;
  };
  return { fetch: vi.fn(implementation), requests };
}
