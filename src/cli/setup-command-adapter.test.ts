// @vitest-environment node
import { expect, test, vi } from "vitest";

import { runCli } from "../cli";
import { encodeConnectionCredential } from "../cli-connection.ts";
import { harness, storedCredential } from "./test-harness.ts";

test("setup parser passes flags over environment fallbacks to the Cloudflare plan", async () => {
  const planSetup = vi.fn(async (input) => ({ mode: "plan", ready: true, input }));
  const context = harness({
    env: {
      CLOUDFLARE_API_TOKEN: "bootstrap-secret",
      SHLOOK_DOMAIN: "environment.example.com",
      SHLOOK_OWNER_EMAIL: "environment@example.com",
      SHLOOK_ACCOUNT_ID: "e".repeat(32),
    },
    planSetup,
  });

  const exitCode = await runCli(
    [
      "setup",
      "--plan",
      "--domain",
      "flag.example.com",
      "--owner-email",
      "flag@example.com",
      "--account-id",
      "f".repeat(32),
      "--json",
    ],
    context.dependencies,
  );
  expect(exitCode, context.stderr.join("")).toBe(0);
  expect(planSetup).toHaveBeenCalledWith({
    domain: "flag.example.com",
    ownerEmail: "flag@example.com",
    accountId: "f".repeat(32),
  });
  expect(context.dependencies.runCommand).not.toHaveBeenCalled();

  const fallback = harness({
    env: context.dependencies.env,
    planSetup,
  });
  expect(await runCli(["setup", "--plan", "--json"], fallback.dependencies)).toBe(0);
  expect(planSetup).toHaveBeenLastCalledWith({
    domain: "environment.example.com",
    ownerEmail: "environment@example.com",
    accountId: "e".repeat(32),
  });
});

test("setup forwards the explicit dangerous adoption flag and never enables it implicitly", async () => {
  const planSetup = vi.fn(async (value) => ({ mode: "plan", value }));
  const environment = {
    CLOUDFLARE_API_TOKEN: "bootstrap-secret",
    SHLOOK_DOMAIN: "example.com",
    SHLOOK_OWNER_EMAIL: "owner@example.com",
  };
  const normal = harness({ env: environment, planSetup });
  expect(await runCli(["setup", "--plan", "--json"], normal.dependencies)).toBe(0);
  expect(planSetup.mock.calls[0][0]).not.toHaveProperty("adoptExisting");

  const dangerous = harness({ env: environment, planSetup });
  expect(
    await runCli(["setup", "--plan", "--adopt-existing", "--json"], dangerous.dependencies),
  ).toBe(0);
  expect(planSetup).toHaveBeenLastCalledWith({
    domain: "example.com",
    ownerEmail: "owner@example.com",
    adoptExisting: true,
  });
});

test("setup apply outputs a connection token only when explicitly requested", async () => {
  const token = encodeConnectionCredential(storedCredential);
  const applySetup = vi.fn(async (input) => ({
    mode: "apply",
    config: { path: "/config/shlook/deployment/wrangler.json" },
    connection: { stored: true, path: "/config/shlook/auth.json" },
    requestedTokenOutput: input.showConnectionToken,
    connectionToken: token,
  }));
  const environment = {
    CLOUDFLARE_API_TOKEN: "bootstrap-secret",
    SHLOOK_DOMAIN: "example.com",
    SHLOOK_OWNER_EMAIL: "owner@example.com",
  };

  const normal = harness({ env: environment, applySetup });
  expect(await runCli(["setup", "--apply", "--json"], normal.dependencies)).toBe(0);
  expect(normal.stdout.join("") + normal.stderr.join("")).not.toContain(token);
  expect(JSON.parse(normal.stdout[0]).data).not.toHaveProperty("connectionToken");

  const explicit = harness({ env: environment, applySetup });
  expect(
    await runCli(["setup", "--apply", "--show-connection-token", "--json"], explicit.dependencies),
  ).toBe(0);
  expect(JSON.parse(explicit.stdout[0]).data.connectionToken).toBe(token);

  const invalid = harness({ env: environment, planSetup: vi.fn() });
  expect(
    await runCli(["setup", "--plan", "--show-connection-token", "--json"], invalid.dependencies),
  ).toBe(1);
  expect(invalid.dependencies.planSetup).not.toHaveBeenCalled();
});
