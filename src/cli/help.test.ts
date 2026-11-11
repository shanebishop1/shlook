// @vitest-environment node
import { expect, test, vi } from "vitest";

import { runCli } from "../cli.ts";
import { CLI_HELP } from "./help.ts";
import { harness } from "./test-harness.ts";

test.each([[], ["-h"], ["--help"], ["help"], ["publish", "--help"], ["setup", "-h"]])(
  "shows help without configuration or side effects for %j",
  async (...argv: string[]) => {
    const context = harness({
      env: {},
      loadConnection: vi.fn(),
      loadProfileConfiguration: vi.fn(),
      readSecretInput: vi.fn(),
      loadPublishInput: vi.fn(),
      applySetup: vi.fn(),
    });

    expect(await runCli(argv, context.dependencies)).toBe(0);
    expect(context.stdout.join("")).toBe(CLI_HELP);
    expect(context.stderr).toEqual([]);
    for (const name of [
      "fetch",
      "runCommand",
      "loadConnection",
      "loadProfileConfiguration",
      "readSecretInput",
      "loadPublishInput",
      "applySetup",
    ] as const)
      expect(context.dependencies[name]).not.toHaveBeenCalled();
    expect(CLI_HELP).toContain("Usage: shlook <command> [options]");
    expect(CLI_HELP).toContain("npx skills add shanebishop1/shlook");
    expect(CLI_HELP).toContain("skills/shlook/SKILL.md");
  },
);

test.each([["--json"], ["--help", "--json"], ["--json", "-h"], ["help", "--json"]])(
  "preserves the JSON envelope for help: %j",
  async (...argv: string[]) => {
    const context = harness({ env: {} });

    expect(await runCli(argv, context.dependencies)).toBe(0);
    expect(JSON.parse(context.stdout.join(""))).toEqual({
      ok: true,
      command: "help",
      data: { help: CLI_HELP },
    });
    expect(context.stderr).toEqual([]);
  },
);

test("still rejects unknown commands", async () => {
  const context = harness({ env: {} });

  expect(await runCli(["not-a-command", "--json"], context.dependencies)).toBe(1);
  expect(context.stdout).toEqual([]);
  expect(JSON.parse(context.stderr.join("")).error.code).toBe("usage_error");
});
