import { describe, expect, it, vi } from "vitest";
import { authenticatedFetch } from "./http.ts";
import { CliError } from "./errors.ts";
import type { CliDependencies } from "./types.ts";

function dependencies(fetch: typeof globalThis.fetch): CliDependencies {
  return {
    cwd: "/repo",
    env: { TOKEN: `shlook_api_v1_${"a".repeat(43)}` },
    fetch,
    runCommand: async () => ({ code: 0 }),
    stdout: () => undefined,
    stderr: () => undefined,
    backend: "native",
    instanceName: "home-lab",
    selectedOrigin: "https://home.example",
    profileTokenEnv: "TOKEN",
  };
}

describe("native authenticated CLI transport", () => {
  it("sends only the native bearer credential and never follows redirects", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.example/leak" },
        }),
    );
    await expect(
      authenticatedFetch(dependencies(fetch), "https://home.example/health"),
    ).rejects.toThrow("authenticated request was redirected");
    const init = fetch.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer shlook_api_v1_${"a".repeat(43)}`);
    expect(headers.has("CF-Access-Client-Id")).toBe(false);
    expect(headers.has("CF-Access-Client-Secret")).toBe(false);
    expect(init?.redirect).toBe("manual");
  });

  it("rejects cross-origin requests and malformed present credentials without fetching", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    await expect(
      authenticatedFetch(dependencies(fetch), "https://attacker.example/health"),
    ).rejects.toBeInstanceOf(CliError);
    expect(fetch).not.toHaveBeenCalled();
    const invalid = dependencies(fetch);
    invalid.env.TOKEN = "not-a-token";
    await expect(authenticatedFetch(invalid, "https://home.example/health")).rejects.toMatchObject({
      code: "invalid_credential",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
