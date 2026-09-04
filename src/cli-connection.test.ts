// @vitest-environment node
import { constants } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
    realpath: vi.fn(async (path) => {
      events.push(`realpath:${path}`);
      return path;
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
    open: vi.fn(async (path, flags) => ({
      chmod: vi.fn(async (mode) => {
        events.push(`fchmod:${path}:${mode.toString(8)}`);
      }),
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
    currentUid: () => 1_000,
  });

  expect(path).toBe("/config/shlook/auth.json");
  expect(events).toEqual([
    "mkdir:/config/shlook:700",
    "realpath:/config/shlook",
    "write:/config/shlook/.auth.json.fixed-id:600:wx",
    "realpath:/config/shlook/auth.json",
    "rename:/config/shlook/.auth.json.fixed-id:/config/shlook/auth.json",
    "realpath:/config/shlook/auth.json",
    "fchmod:/config/shlook/auth.json:600",
  ]);
});

test("rejects mocked ancestor redirection before credential access", async () => {
  const persisted = fileSystemHarness();
  vi.mocked(persisted.fs.realpath).mockResolvedValue("/redirected/config/shlook");

  await expect(
    persistConnectionCredential(credential, {
      env: { XDG_CONFIG_HOME: "/config" },
      fs: persisted.fs,
      randomId: () => "fixed-id",
      currentUid: () => 1_000,
    }),
  ).rejects.toThrow("unable to persist connection credential");
  expect(persisted.fs.writeFile).not.toHaveBeenCalled();
  expect(persisted.fs.chmod).not.toHaveBeenCalled();

  const loaded = fileSystemHarness();
  vi.mocked(loaded.fs.realpath).mockResolvedValue("/redirected/config/shlook/auth.json");
  await expect(
    loadConnectionCredential({
      env: { XDG_CONFIG_HOME: "/config" },
      fs: loaded.fs,
      currentUid: () => 1_000,
    }),
  ).rejects.toThrow("unable to load connection credential");
  expect(loaded.fs.open).not.toHaveBeenCalled();
});

test("rejects persistence before filesystem access when POSIX ownership is unavailable", async () => {
  const { fs } = fileSystemHarness();

  await expect(
    persistConnectionCredential(credential, {
      env: { XDG_CONFIG_HOME: "/config" },
      fs,
      randomId: () => "fixed-id",
      currentUid: () => undefined,
    }),
  ).rejects.toThrow("unable to persist connection credential");

  expect(fs.mkdir).not.toHaveBeenCalled();
  expect(fs.writeFile).not.toHaveBeenCalled();
  expect(fs.rename).not.toHaveBeenCalled();
  expect(fs.chmod).not.toHaveBeenCalled();
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

test("rejects loading before filesystem access when POSIX ownership is unavailable", async () => {
  const { fs } = fileSystemHarness();

  await expect(
    loadConnectionCredential({
      env: { XDG_CONFIG_HOME: "/config" },
      fs,
      currentUid: () => undefined,
    }),
  ).rejects.toThrow("unable to load connection credential");

  expect(fs.open).not.toHaveBeenCalled();
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

test("persists credentials beneath an ordinary absolute temporary path", async () => {
  const root = await mkdtemp(join(tmpdir(), "shlook-connection-ordinary-"));
  try {
    const path = join(root, "shlook", "auth.json");
    await expect(
      persistConnectionCredential(credential, { env: { XDG_CONFIG_HOME: root } }),
    ).resolves.toBe(path);
    await expect(readFile(path, "utf8")).resolves.toBe(`${JSON.stringify(credential)}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects real symlinked credential directories without writing through them", async () => {
  const root = await mkdtemp(join(tmpdir(), "shlook-connection-symlink-"));
  const redirected = join(root, "redirected");
  await mkdir(redirected);

  try {
    const xdgLink = join(root, "xdg-link");
    await symlink(redirected, xdgLink, "dir");
    await expect(
      persistConnectionCredential(credential, { env: { XDG_CONFIG_HOME: xdgLink } }),
    ).rejects.toThrow("unable to persist connection credential");

    const home = join(root, "home");
    const config = join(home, ".config");
    await mkdir(config, { recursive: true });
    await symlink(redirected, join(config, "shlook"), "dir");
    await expect(
      persistConnectionCredential(credential, { env: {}, home: () => home }),
    ).rejects.toThrow("unable to persist connection credential");

    await expect(loadConnectionCredential({ env: {}, home: () => home })).rejects.toThrow(
      "unable to load connection credential",
    );
    await expect(
      writeFile(join(redirected, "auth.json"), "untouched", { flag: "wx" }),
    ).resolves.toBe(undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
