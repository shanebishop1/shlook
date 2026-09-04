// @vitest-environment node
import { constants } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

function fileSystemHarness(
  contents = JSON.stringify(credential),
  statOverrides: Partial<{ isFile: () => boolean; uid: number; mode: number; size: number }> = {},
) {
  const events: string[] = [];
  const contentBytes = Buffer.from(contents);
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
    open: vi.fn(async (_path, flags) => ({
      stat: vi.fn(async () => ({
        isFile: () => true,
        uid: 1_000,
        mode: 0o100600,
        size: contentBytes.byteLength,
        ...statOverrides,
      })),
      read: vi.fn(async (buffer, offset, length, position) => {
        const bytesRead = contentBytes.copy(buffer, offset, position, position + length);
        return { bytesRead };
      }),
      close: vi.fn(async () => undefined),
      flags,
    })),
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
      currentUid: () => 1_000,
    }),
  ).resolves.toEqual(credential);
  expect(valid.fs.open).toHaveBeenCalledWith(
    "/config/shlook/auth.json",
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );

  const secret = "stored-secret-must-not-leak";
  const invalid = fileSystemHarness(
    `{"domain":"example.com","accessClientId":"id","accessClientSecret":"${secret}","constructor":{}}`,
  );
  await expect(
    loadConnectionCredential({
      env: { XDG_CONFIG_HOME: "/config" },
      home: () => "/ignored",
      fs: invalid.fs,
      currentUid: () => 1_000,
    }),
  ).rejects.not.toThrow(secret);

  const wrongOwner = fileSystemHarness(JSON.stringify(credential), { uid: 1_001 });
  await expect(
    loadConnectionCredential({
      env: { XDG_CONFIG_HOME: "/config" },
      fs: wrongOwner.fs,
      currentUid: () => 1_000,
    }),
  ).rejects.toThrow("unable to load connection credential");

  const fifo = fileSystemHarness(JSON.stringify(credential), { isFile: () => false });
  await expect(
    loadConnectionCredential({
      env: { XDG_CONFIG_HOME: "/config" },
      fs: fifo.fs,
      currentUid: () => 1_000,
    }),
  ).rejects.toThrow("unable to load connection credential");

  const growsAfterStat = fileSystemHarness(`${JSON.stringify(credential)}${" ".repeat(20_000)}`, {
    size: 1,
  });
  await expect(
    loadConnectionCredential({
      env: { XDG_CONFIG_HOME: "/config" },
      fs: growsAfterStat.fs,
      currentUid: () => 1_000,
    }),
  ).rejects.toThrow("unable to load connection credential");
});

test("rejects real credential files with broad permissions or oversized contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "shlook-connection-"));
  const directory = join(root, "shlook");
  const path = join(directory, "auth.json");
  await mkdir(directory, { mode: 0o700 });

  try {
    await writeFile(path, JSON.stringify(credential), { mode: 0o600 });
    await chmod(path, 0o644);
    await expect(loadConnectionCredential({ env: { XDG_CONFIG_HOME: root } })).rejects.toThrow(
      "unable to load connection credential",
    );

    await writeFile(path, `${JSON.stringify(credential)}${" ".repeat(20_000)}`, { mode: 0o600 });
    await chmod(path, 0o600);
    await expect(loadConnectionCredential({ env: { XDG_CONFIG_HOME: root } })).rejects.toThrow(
      "unable to load connection credential",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
