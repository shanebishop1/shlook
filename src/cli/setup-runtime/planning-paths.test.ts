// @vitest-environment node
import { expect, test, vi } from "vitest";

import { planSetupRuntime, resolveSetupConfigPath } from "../../cli-setup-runtime.ts";
import { isolatedCommandEnvironment } from "../../cli.ts";
import { ACCOUNT_ID, BOOTSTRAP_TOKEN, applied } from "./persistence-test-fixtures.ts";
import { runtimeHarness } from "./runtime-test-harness.ts";

test("resolves the setup config beneath a safe XDG or home config directory", () => {
  expect(resolveSetupConfigPath({ XDG_CONFIG_HOME: "/config" }, () => "/ignored")).toBe(
    "/config/shlook/deployment/wrangler.json",
  );
  expect(resolveSetupConfigPath({}, () => "/home/alice")).toBe(
    "/home/alice/.config/shlook/deployment/wrangler.json",
  );
  expect(() =>
    resolveSetupConfigPath({ XDG_CONFIG_HOME: "../escape" }, () => "/home/alice"),
  ).toThrow("invalid setup configuration path");
});

test("the command environment never inherits unrelated process credentials", () => {
  const previous = process.env.UNRELATED_SECRET;
  process.env.UNRELATED_SECRET = "inherited-secret";
  try {
    expect(
      isolatedCommandEnvironment({
        CLOUDFLARE_API_TOKEN: BOOTSTRAP_TOKEN,
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      }),
    ).toEqual({
      CLOUDFLARE_API_TOKEN: BOOTSTRAP_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    });
  } finally {
    if (previous === undefined) delete process.env.UNRELATED_SECRET;
    else process.env.UNRELATED_SECRET = previous;
  }
});

test("plan loads ownership state and delegates without local or command mutations", async () => {
  const plan = { ...applied, mode: "plan" as const, ready: true, actions: [], capabilities: {} };
  const planCloudflareSetup = vi.fn(async () => plan);
  const context = runtimeHarness({ planCloudflareSetup });

  await expect(
    planSetupRuntime(
      { domain: "example.com", ownerEmail: "owner@example.com", accountId: ACCOUNT_ID },
      context.dependencies,
    ),
  ).resolves.toBe(plan);
  expect(planCloudflareSetup).toHaveBeenCalledWith(
    { domain: "example.com", ownerEmail: "owner@example.com", accountId: ACCOUNT_ID },
    { env: context.dependencies.env, fetch: context.dependencies.fetch },
  );
  expect(context.runCommand).not.toHaveBeenCalled();
  expect(context.persistConnection).not.toHaveBeenCalled();
  expect(context.fileSystem.events).toEqual([
    "realpath:/config/shlook/deployment/manifest.json",
    "open:/config/shlook/deployment/manifest.json",
  ]);
  expect(context.dependencies.randomBytes).not.toHaveBeenCalled();
});
