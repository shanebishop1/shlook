// @vitest-environment node
import { expect, test, vi } from "vitest";

import { planSetup, type ApplySetupInput } from "../../cli-setup.ts";
import {
  TOKEN,
  baseResponse,
  capturedError,
  harness,
  input,
  page,
} from "./cloudflare-test-harness.ts";

test("uses the standard bootstrap token, supports the alias, and rejects conflicts", async () => {
  const standard = harness();
  await planSetup(input, standard.dependencies);
  expect(standard.requests[0].headers.get("authorization")).toBe(`Bearer ${TOKEN}`);

  const alias = harness(({ url }) => baseResponse(url), { SHLOOK_CF_TOKEN: "alias-token" });
  await planSetup(input, alias.dependencies);
  expect(alias.requests[0].headers.get("authorization")).toBe("Bearer alias-token");

  const equal = harness(({ url }) => baseResponse(url), {
    CLOUDFLARE_API_TOKEN: TOKEN,
    SHLOOK_CF_TOKEN: TOKEN,
  });
  await planSetup(input, equal.dependencies);
  expect(equal.requests[0].headers.get("authorization")).toBe(`Bearer ${TOKEN}`);

  const conflicting = harness(vi.fn(), {
    CLOUDFLARE_API_TOKEN: "standard-secret",
    SHLOOK_CF_TOKEN: "different-secret",
  });
  const error = await capturedError(planSetup(input, conflicting.dependencies));
  expect(error).toMatchObject({
    code: "bootstrap_token_conflict",
    message: "conflicting Cloudflare bootstrap token environment variables",
  });
  expect(conflicting.requests).toEqual([]);
  expect(`${error.message}${JSON.stringify(error)}`).not.toContain("standard-secret");
  expect(`${error.message}${JSON.stringify(error)}`).not.toContain("different-secret");
});

test("validates domain, owner email, account ID, and missing token before network access", async () => {
  const cases: Array<[ApplySetupInput, Record<string, string | undefined>, string]> = [
    [
      { ...input, domain: "https://example.com" },
      { CLOUDFLARE_API_TOKEN: TOKEN },
      "invalid_domain",
    ],
    [{ ...input, domain: "example.com/path" }, { CLOUDFLARE_API_TOKEN: TOKEN }, "invalid_domain"],
    [{ ...input, domain: "127.0.0.1" }, { CLOUDFLARE_API_TOKEN: TOKEN }, "invalid_domain"],
    [
      { ...input, ownerEmail: "not-an-email" },
      { CLOUDFLARE_API_TOKEN: TOKEN },
      "invalid_owner_email",
    ],
    [
      { ...input, ownerEmail: "a..b@example.com" },
      { CLOUDFLARE_API_TOKEN: TOKEN },
      "invalid_owner_email",
    ],
    [{ ...input, accountId: "short" }, { CLOUDFLARE_API_TOKEN: TOKEN }, "invalid_account_id"],
    [input, {}, "bootstrap_token_required"],
  ];
  for (const [invalidInput, env, code] of cases) {
    const context = harness(vi.fn(), env);
    expect((await capturedError(planSetup(invalidInput, context.dependencies))).code).toBe(code);
    expect(context.requests).toEqual([]);
  }
});

test("rejects redirect responses and never forwards authorization", async () => {
  const context = harness(
    () =>
      new Response(null, { status: 302, headers: { location: "https://attacker.invalid/steal" } }),
  );
  const error = await capturedError(planSetup(input, context.dependencies));
  expect(error).toMatchObject({
    code: "cloudflare_redirect_rejected",
    message: "Cloudflare API redirects are not allowed",
    status: 302,
  });
  expect(context.requests).toHaveLength(1);
  expect(context.requests[0].redirect).toBe("manual");
});

test("returns stable errors without leaking bootstrap tokens or provider bodies", async () => {
  const network = harness(() => {
    throw new Error(`socket failed with ${TOKEN}`);
  });
  const networkError = await capturedError(planSetup(input, network.dependencies));
  expect(networkError).toMatchObject({
    code: "cloudflare_request_failed",
    message: "Cloudflare API request failed",
  });
  expect(networkError.message).not.toContain(TOKEN);

  const denied = harness(() =>
    Response.json({ success: false, errors: [{ message: `bad ${TOKEN}` }] }, { status: 401 }),
  );
  const deniedError = await capturedError(planSetup(input, denied.dependencies));
  expect(deniedError).toMatchObject({
    code: "cloudflare_authentication_failed",
    message: "Cloudflare bootstrap token verification failed",
    status: 401,
  });
  expect(`${deniedError.message}${JSON.stringify(deniedError)}`).not.toContain(TOKEN);
});

test("rejects malformed and oversized Cloudflare responses with bounded generic errors", async () => {
  const malformedJson = harness(
    () => new Response("{not-json", { headers: { "content-type": "application/json" } }),
  );
  expect((await capturedError(planSetup(input, malformedJson.dependencies))).code).toBe(
    "cloudflare_response_invalid",
  );

  const malformedEnvelope = harness(() => Response.json({ success: true, result: "wrong" }));
  expect((await capturedError(planSetup(input, malformedEnvelope.dependencies))).code).toBe(
    "cloudflare_response_invalid",
  );

  const malformedMembership = harness(({ url }) => {
    if (url.pathname === "/client/v4/memberships") {
      return page([
        {
          status: "accepted",
          account: { id: "../../not-an-account", name: "Malformed" },
        },
      ]);
    }
    return baseResponse(url);
  });
  expect((await capturedError(planSetup(input, malformedMembership.dependencies))).code).toBe(
    "cloudflare_response_invalid",
  );

  const oversized = harness(
    () =>
      new Response("x".repeat(1_048_577), {
        headers: { "content-type": "application/json", "content-length": "1048577" },
      }),
  );
  const oversizedError = await capturedError(planSetup(input, oversized.dependencies));
  expect(oversizedError).toMatchObject({
    code: "cloudflare_response_too_large",
    message: "Cloudflare API response exceeded the allowed size",
  });
});
