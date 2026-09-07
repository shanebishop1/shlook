// @vitest-environment node
import { expect, test } from "vitest";

import { readConnectionToken } from "../cli";
import { SecretInput, secretOutput } from "./test-harness.ts";

function expectTerminalRestored(input: SecretInput, initiallyRaw = false): void {
  expect(input.isRaw).toBe(initiallyRaw);
  expect(input.isPaused()).toBe(true);
  expect(input.eventNames()).toEqual([]);
}

test("reads a hidden TTY connection token through Enter and restores the terminal", async () => {
  const input = new SecretInput(true, true);
  const output = secretOutput();
  const reading = readConnectionToken(input, output.stream);

  input.emit("data", Buffer.from("pasted-secret\r\n"));

  await expect(reading).resolves.toBe("pasted-secret");
  expect(output.chunks.join("")).toBe("Connection token: \n");
  expect(output.chunks.join("")).not.toContain("pasted-secret");
  expect(input.rawModes).toEqual([true, false]);
  expect(input.resume).toHaveBeenCalledOnce();
  expect(input.pause).toHaveBeenCalledOnce();
  expectTerminalRestored(input);
});

test("handles TTY backspace without echoing input and preserves an existing raw/flowing state", async () => {
  const input = new SecretInput(true, false, true);
  const output = secretOutput();
  const reading = readConnectionToken(input, output.stream);

  input.emit("data", "pasted-XY\u007f\btoken\n");

  await expect(reading).resolves.toBe("pasted-token");
  expect(output.chunks.join("")).not.toContain("pasted-");
  expect(input.rawModes).toEqual([true, true]);
  expect(input.pause).not.toHaveBeenCalled();
  expect(input.isRaw).toBe(true);
  expect(input.isPaused()).toBe(false);
  expect(input.eventNames()).toEqual([]);
});

test("rejects empty TTY input and restores terminal state", async () => {
  const input = new SecretInput(true, true);
  const output = secretOutput();
  const reading = readConnectionToken(input, output.stream);

  input.emit("data", "\r");

  await expect(reading).rejects.toThrow("connection credential input is required");
  expect(output.chunks.join("")).toBe("Connection token: \n");
  expectTerminalRestored(input);
});

test("cancels TTY input on Ctrl-C without leaking or leaving terminal state changed", async () => {
  const input = new SecretInput(true, true);
  const output = secretOutput();
  const reading = readConnectionToken(input, output.stream);

  input.emit("data", "do-not-print\u0003");

  await expect(reading).rejects.toThrow("connection credential input cancelled");
  expect(output.chunks.join("")).toBe("Connection token: \n");
  expect(output.chunks.join("")).not.toContain("do-not-print");
  expectTerminalRestored(input);
});

test("bounds TTY input at 20KB and restores terminal state", async () => {
  const input = new SecretInput(true, true);
  const output = secretOutput();
  const reading = readConnectionToken(input, output.stream);

  input.emit("data", "x".repeat(20_001));

  await expect(reading).rejects.toThrow("connection credential input is invalid");
  expect(output.chunks.join("")).not.toContain("xxx");
  expectTerminalRestored(input);
});

test("restores TTY state after a stream error without disclosing buffered input", async () => {
  const input = new SecretInput(true, true);
  const output = secretOutput();
  const reading = readConnectionToken(input, output.stream);

  input.emit("data", "buffered-secret");
  input.emit("error", new Error("terminal failed"));

  await expect(reading).rejects.toThrow("terminal failed");
  expect(output.chunks.join("")).not.toContain("buffered-secret");
  expectTerminalRestored(input);
});

test("continues reading piped connection tokens without prompting", async () => {
  const input = new SecretInput(false, true);
  const output = secretOutput();
  const reading = readConnectionToken(input, output.stream);

  input.emit("data", Buffer.from("  piped-token\r\n"));
  input.emit("end");

  await expect(reading).resolves.toBe("piped-token");
  expect(output.chunks).toEqual([]);
  expect(input.rawModes).toEqual([]);
  expectTerminalRestored(input);
});
