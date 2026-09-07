import { Buffer } from "node:buffer";

import { expect, vi } from "vitest";

import type { ApplySetupInput } from "../../cli-setup.ts";
import type { SetupCommandOptions, SetupRuntimeFileSystem } from "../../cli-setup-runtime.ts";
import {
  ACCESS_SECRET,
  BOOTSTRAP_TOKEN,
  applied,
  deploymentManifest,
} from "./persistence-test-fixtures.ts";

export function fileSystemHarness() {
  const events: string[] = [];
  let config = "";
  const files = new Map<
    string,
    { data: string; mode: number; type: "file" | "fifo" | "symlink"; uid: number }
  >();
  const fs: SetupRuntimeFileSystem = {
    mkdir: vi.fn(async (path, options) => {
      events.push(`mkdir:${path}:${options.mode.toString(8)}`);
    }),
    realpath: vi.fn(async (path) => {
      events.push(`realpath:${path}`);
      return path;
    }),
    chmod: vi.fn(async (path, mode) => {
      events.push(`chmod:${path}:${mode.toString(8)}`);
      const value = files.get(path);
      if (value !== undefined) value.mode = mode;
    }),
    writeFile: vi.fn(async (path, data, options) => {
      if (files.has(path)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      events.push(`write:${path}:${options.mode.toString(8)}:${options.flag}`);
      files.set(path, { data, mode: options.mode, type: "file", uid: process.getuid?.() ?? 0 });
      if (path.includes(".wrangler.json.")) config = data;
    }),
    rename: vi.fn(async (from, to) => {
      events.push(`rename:${from}:${to}`);
      const value = files.get(from);
      if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      files.set(to, value);
      files.delete(from);
    }),
    unlink: vi.fn(async (path) => {
      events.push(`unlink:${path}`);
      if (!files.delete(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }),
    link: vi.fn(async (from, to) => {
      events.push(`link:${from}:${to}`);
      if (files.has(to)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      const value = files.get(from);
      if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      files.set(to, value);
    }),
    open: vi.fn(async (path) => {
      events.push(`open:${path}`);
      const value = files.get(path);
      if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      if (value.type === "symlink") throw Object.assign(new Error("symlink"), { code: "ELOOP" });
      return {
        chmod: vi.fn(async (mode) => {
          events.push(`fchmod:${path}:${mode.toString(8)}`);
          value.mode = mode;
        }),
        stat: vi.fn(async () => ({
          isFile: () => value.type === "file",
          mode: value.mode,
          size: Buffer.byteLength(value.data),
          uid: value.uid,
        })),
        readFile: vi.fn(async () => value.data),
        close: vi.fn(async () => undefined),
      };
    }),
  };
  return {
    fs,
    events,
    files,
    config: () => config,
    putFile: (
      path: string,
      data: string,
      mode = 0o600,
      type: "file" | "fifo" | "symlink" = "file",
    ) => files.set(path, { data, mode, type, uid: process.getuid?.() ?? 0 }),
  };
}

export function runtimeHarness(overrides: Record<string, unknown> = {}) {
  const fileSystem = fileSystemHarness();
  const events: string[] = [];
  const deployedSecrets: string[] = [];
  const runCommand = vi.fn(
    async (_command: string, args: string[], _options: SetupCommandOptions) => {
      events.push("command");
      const index = args.indexOf("--secrets-file");
      if (index !== -1) {
        const data = fileSystem.files.get(args[index + 1])?.data;
        if (data !== undefined) deployedSecrets.push(data);
      }
      return { code: 0 };
    },
  );
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    events.push(`fetch:${String(input)}`);
    expect(init?.redirect).toBe("manual");
    return String(input).endsWith("/health")
      ? Response.json({ ok: true, service: "shlook" })
      : Response.json({ error: "not_found" }, { status: 404 });
  });
  let persistedCredential:
    | { domain: string; accessClientId: string; accessClientSecret: string }
    | undefined;
  const persistConnection = vi.fn(async (credential) => {
    events.push("persist");
    persistedCredential = credential;
    return "/config/shlook/auth.json";
  });
  const loadConnection = vi.fn(async () => {
    if (persistedCredential === undefined) throw new Error("missing");
    return persistedCredential;
  });
  const applyCloudflareSetup = vi.fn(async (rawInput: unknown) => {
    const applyInput = rawInput as ApplySetupInput;
    await applyInput.persistence?.saveIntent(applyInput.deploymentManifest ?? deploymentManifest);
    if (applyInput.existingServiceToken !== undefined) {
      return {
        ...applied,
        resources: {
          ...applied.resources,
          accessServiceToken: { ...applied.resources.accessServiceToken, created: false },
        },
        createdServiceTokenCredentials: undefined,
      };
    }
    await applyInput.persistence?.saveServiceToken({
      resourceId: "service-token-id",
      clientId: "access-client-id",
      clientSecret: ACCESS_SECRET,
    });
    return applied;
  });
  const dependencies = {
    env: {
      SHLOOK_CF_TOKEN: BOOTSTRAP_TOKEN,
      XDG_CONFIG_HOME: "/config",
      CF_ACCESS_CLIENT_ID: "must-not-reach-wrangler",
      CF_ACCESS_CLIENT_SECRET: "must-not-reach-wrangler",
      UNRELATED_SECRET: "must-not-reach-wrangler",
    },
    fetch,
    packageRoot: "/package",
    nodeExecutable: "/node",
    wranglerPath: "/package/node_modules/wrangler/bin/wrangler.js",
    runCommand,
    persistConnection,
    loadConnection,
    applyCloudflareSetup,
    reconcileCloudflareSetup: vi.fn(async ({ deploymentManifest: value }) => value),
    fs: fileSystem.fs,
    randomBytes: vi.fn(() => Buffer.alloc(32, 7)),
    randomId: vi.fn(() => "fixed-id"),
    sleep: vi.fn(async () => undefined),
    ...overrides,
  };
  return {
    dependencies,
    events,
    fileSystem,
    fetch,
    persistConnection,
    runCommand,
    deployedSecrets,
  };
}
