import { describe, expect, it } from "vitest";

import { handleRequest, type Env } from "./index";

const env = {} as Env;

describe("worker bootstrap", () => {
  it("reports service health", async () => {
    const response = await handleRequest(new Request("https://show.test/health"), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "shlook" });
  });

  it("rejects unknown routes", async () => {
    const response = await handleRequest(new Request("https://show.test/missing"), env);

    expect(response.status).toBe(404);
  });
});
