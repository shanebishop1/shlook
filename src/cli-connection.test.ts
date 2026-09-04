// @vitest-environment node
import { expect, test, vi } from "vitest";

import {
  decodeConnectionCredential,
  encodeConnectionCredential,
  loadConnectionCredential,
  persistConnectionCredential,
  resolveConnectionAuthPath,
  type ConnectionCredential,
  type ConnectionFileSystem,
} from "./cli-connection.ts";

const credential: ConnectionCredential = {
  domain: "example.com",
  accessClientId: "client-id-value",
  accessClientSecret: "super-secret-value",
};

function tokenFor(value: unknown): string {
  return `shlook_connect_v1_${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}

test("encodes one canonical copyable token and decodes it", () => {
  const token = encodeConnectionCredential(credential);

  expect(token).toMatch(/^shlook_connect_v1_[A-Za-z0-9_-]+$/);
  expect(decodeConnectionCredential(token)).toEqual(credential);
  expect(encodeConnectionCredential(decodeConnectionCredential(token))).toBe(token);
});

test("strictly rejects malformed credentials without exposing secrets", () => {
  const maliciousSecret = "do-not-leak-this-secret";
  const invalidValues = [
    "shlook_connect_v2_e30",
    "shlook_connect_v1_%%%",
    tokenFor({
      ...credential,
      domain: "https://example.com/path",
      accessClientSecret: maliciousSecret,
    }),
    tokenFor({ ...credential, domain: "localhost", accessClientSecret: maliciousSecret }),
    tokenFor({ ...credential, extra: "unexpected", accessClientSecret: maliciousSecret }),
    tokenFor(
      JSON.parse(
        `{"domain":"example.com","accessClientId":"id","accessClientSecret":"${maliciousSecret}","__proto__":{"polluted":true}}`,
      ),
    ),
  ];

  for (const value of invalidValues) {
    expect(() => decodeConnectionCredential(value)).toThrow("invalid connection credential");
    try {
      decodeConnectionCredential(value);
    } catch (error) {
      expect(String(error)).not.toContain(maliciousSecret);
    }
  }
  expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
});

test("resolves only safe absolute XDG or home auth paths", () => {
  expect(
    resolveConnectionAuthPath({
      env: Object.assign(Object.create({ XDG_CONFIG_HOME: "/inherited" }), {}),
      home: () => "/home/alice",
    }),
  ).toBe("/home/alice/.config/shlook/auth.json");
  expect(
    resolveConnectionAuthPath({ env: { XDG_CONFIG_HOME: "/xdg/config" }, home: () => "/ignored" }),
  ).toBe("/xdg/config/shlook/auth.json");
  expect(() =>
    resolveConnectionAuthPath({ env: { XDG_CONFIG_HOME: "../escape" }, home: () => "/home/alice" }),
  ).toThrow("invalid connection auth path");
  expect(() => resolveConnectionAuthPath({ env: {}, home: () => "/" })).toThrow(
    "invalid connection auth path",
  );
});

function fileSystemHarness(contents = JSON.stringify(credential)) {
  const events: string[] = [];
  const fs: ConnectionFileSystem = {
    mkdir: vi.fn(async (path, options) => {
      events.push(`mkdir:${path}:${options.mode.toString(8)}`);
    }),
    writeFile: vi.fn(async (path, data, options) => {
      events.push(`write:${path}:${options.mode.toString(8)}:${options.flag}`);
      expect(data).toBe(`${JSON.stringify(credential)}\n`);
    }),
    rename: vi.fn(async (from, to) => {
      events.push(`rename:${from}:${to}`);
    }),
    chmod: vi.fn(async (path, mode) => {
      events.push(`chmod:${path}:${mode.toString(8)}`);
    }),
    readFile: vi.fn(async () => contents),
    unlink: vi.fn(async (path) => {
      events.push(`unlink:${path}`);
    }),
  };
  return { fs, events };
}

test("atomically persists auth.json with owner-only permissions", async () => {
  const { fs, events } = fileSystemHarness();
  const path = await persistConnectionCredential(credential, {
    env: { XDG_CONFIG_HOME: "/config" },
    home: () => "/ignored",
    fs,
    randomId: () => "fixed-id",
  });

  expect(path).toBe("/config/shlook/auth.json");
  expect(events).toEqual([
    "mkdir:/config/shlook:700",
    "write:/config/shlook/.auth.json.fixed-id:600:wx",
    "rename:/config/shlook/.auth.json.fixed-id:/config/shlook/auth.json",
    "chmod:/config/shlook/auth.json:600",
  ]);
});

test("loads and validates auth.json without prototype or secret-bearing errors", async () => {
  const valid = fileSystemHarness();
  await expect(
    loadConnectionCredential({
      env: { XDG_CONFIG_HOME: "/config" },
      home: () => "/ignored",
      fs: valid.fs,
    }),
  ).resolves.toEqual(credential);

  const secret = "stored-secret-must-not-leak";
  const invalid = fileSystemHarness(
    `{"domain":"example.com","accessClientId":"id","accessClientSecret":"${secret}","constructor":{}}`,
  );
  await expect(
    loadConnectionCredential({
      env: { XDG_CONFIG_HOME: "/config" },
      home: () => "/ignored",
      fs: invalid.fs,
    }),
  ).rejects.not.toThrow(secret);
});
