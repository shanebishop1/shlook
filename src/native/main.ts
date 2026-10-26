#!/usr/bin/env node
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { addUser, disableUser, issueToken, listUsers } from "./admin.ts";
import { initConfig, loadConfig, type NativeConfig } from "./config.ts";
import { createNativeApplication } from "./router.ts";
import { listenLoopback } from "./server.ts";
import { NativeStore } from "./store.ts";

type Parsed = { positional: string[]; flags: Map<string, string[]> };

function parseArgs(args: string[]): Parsed {
  const positional: string[] = [],
    flags = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (!/^[a-z][a-z-]*$/.test(name) || (flags.has(name) && name !== "alias"))
      throw new Error("invalid or duplicate option");
    if (name === "allow-loopback-http") {
      flags.set(name, ["true"]);
      continue;
    }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error("missing option value");
    flags.set(name, name === "alias" ? [...(flags.get(name) ?? []), value] : [value]);
  }
  return { positional, flags };
}

function options(parsed: Parsed, allowed: string[]) {
  for (const name of parsed.flags.keys())
    if (!allowed.includes(name)) throw new Error("unknown option");
  return {
    get(name: string, required = false) {
      const value = parsed.flags.get(name)?.[0];
      if (required && value === undefined) throw new Error("missing required option");
      return value;
    },
    has(name: string) {
      return parsed.flags.has(name);
    },
  };
}

function dataDir(opts: ReturnType<typeof options>) {
  const value = opts.get("data-dir", true)!;
  if (!value.startsWith("/")) throw new Error("data directory must be absolute");
  return resolve(value);
}
function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
function withStore<T>(path: string, action: (store: NativeStore) => T): T {
  // Require server.json before opening SQLite: admin commands must not bootstrap blank instances.
  loadConfig(path);
  const store = new NativeStore(path);
  try {
    return action(store);
  } finally {
    store.close();
  }
}

function routeClass(request: IncomingMessage) {
  const path = request.url?.split("?", 1)[0] ?? "/";
  return path === "/health" || path.startsWith("/api/")
    ? "api"
    : path.startsWith("/assets/") || path.startsWith("/preview/")
      ? "asset"
      : path === "/login"
        ? "login"
        : "other";
}

export function attachRequestLogging(
  server: Server,
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
) {
  server.prependListener("request", (request: IncomingMessage, response: ServerResponse) => {
    const requestId = randomUUID();
    response.setHeader("X-Request-ID", requestId);
    response.once("finish", () => {
      const method = /^[A-Z]{1,12}$/.test(request.method ?? "") ? request.method : "OTHER";
      write(`${method} ${routeClass(request)} ${response.statusCode} ${requestId}`);
    });
  });
}

export async function run(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (!command) throw new Error("command required");
  const parsed = parseArgs(rest);
  if (command === "init") {
    const o = options(parsed, ["data-dir", "origin", "alias", "allow-loopback-http"]);
    if (parsed.positional.length) throw new Error("unexpected arguments");
    const dir = dataDir(o);
    const allow = o.has("allow-loopback-http");
    if (existsSync(resolve(dir, "server.sqlite")) || existsSync(resolve(dir, "server.json")))
      throw new Error("data directory is already initialized");
    const config: NativeConfig = {
      version: 1,
      origin: o.get("origin", true)!,
      aliases: parsed.flags.get("alias") ?? [],
      allowLoopbackHttp: allow,
    };
    initConfig(dir, config);
    const store = new NativeStore(dir);
    store.close();
    print({ ok: true, dataDir: dir });
    return;
  }
  if (command === "start") {
    const o = options(parsed, ["data-dir", "host", "port"]);
    if (parsed.positional.length) throw new Error("unexpected arguments");
    const dir = dataDir(o),
      config = loadConfig(dir);
    const host = o.get("host") ?? "127.0.0.1";
    const portText = o.get("port") ?? "8789";
    if (!/^\d{1,5}$/.test(portText)) throw new Error("invalid port");
    const port = Number(portText);
    const store = new NativeStore(dir, true);
    let app: ReturnType<typeof createNativeApplication> | undefined;
    let closing = false;
    try {
      // Browser handlers are only needed by the long-running HTTP service.
      const ui = await import("./ui/index.js");
      const handlers = ui.createNativeUiHandler();
      app = createNativeApplication({
        store,
        config,
        loginHandler: handlers.loginHandler,
        ownerHandler: handlers.ownerHandler,
      });
      attachRequestLogging(app.server);
      await listenLoopback(app.server, host, port);
      const close = () => {
        if (closing) return;
        closing = true;
        app!.dispose();
        app!.server.close(() => {
          store.close();
          process.exitCode = 0;
        });
      };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
      const address = app.server.address();
      const activePort = address && typeof address === "object" ? address.port : port;
      process.stderr.write(`shlook-server listening on ${host}:${activePort}\n`);
      await new Promise<void>((resolvePromise) => app!.server.once("close", resolvePromise));
    } catch (error) {
      app?.dispose();
      try {
        app?.server.close();
      } catch {}
      store.close();
      throw error;
    }
    return;
  }
  if (["user", "token"].includes(command)) {
    const [action, identifier] = parsed.positional;
    const allowed =
      command === "user"
        ? action === "add"
          ? ["data-dir", "display-name"]
          : ["data-dir"]
        : action === "issue"
          ? ["data-dir", "user", "name", "role", "expires", "token-file"]
          : action === "list"
            ? ["data-dir", "user"]
            : ["data-dir"];
    const o = options(parsed, allowed);
    const dir = dataDir(o);
    if (command === "user" && action === "add" && identifier && parsed.positional.length === 2) {
      print(withStore(dir, (store) => addUser(store, identifier, o.get("display-name", true)!)));
      return;
    }
    if (command === "user" && action === "list" && !identifier && parsed.positional.length === 1) {
      print(withStore(dir, listUsers));
      return;
    }
    if (
      command === "user" &&
      action === "disable" &&
      identifier &&
      parsed.positional.length === 2
    ) {
      print(
        withStore(dir, (store) => {
          disableUser(store, identifier);
          return { ok: true };
        }),
      );
      return;
    }
    if (
      command === "token" &&
      action === "issue" &&
      !identifier &&
      parsed.positional.length === 1
    ) {
      const user = o.get("user", true)!;
      const name = o.get("name", true)!;
      const role = o.get("role", true)!;
      if (role !== "viewer" && role !== "publisher") throw new Error("invalid role");
      const expires = o.get("expires");
      const expiresAt = expires === undefined ? undefined : Date.parse(expires);
      if (
        expires !== undefined &&
        (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(expires) ||
          !Number.isFinite(expiresAt))
      )
        throw new Error("invalid expiry");
      const tokenFile = o.get("token-file");
      if (!tokenFile && (!process.stdout.isTTY || !process.stderr.isTTY))
        throw new Error("token issue requires a local TTY or --token-file");
      const result = withStore(dir, (store) =>
        issueToken(store, user, name, role, expiresAt, tokenFile),
      );
      if ("secret" in result) {
        process.stderr.write(`Token (shown once): ${result.secret}\n`);
        print({ id: result.id, expiresAt: result.expiresAt });
      } else print(result);
      return;
    }
    if (command === "token" && action === "list" && !identifier && parsed.positional.length === 1) {
      print(withStore(dir, (store) => store.listTokens(o.get("user", true)!)));
      return;
    }
    if (
      command === "token" &&
      action === "revoke" &&
      identifier &&
      parsed.positional.length === 2
    ) {
      print(
        withStore(dir, (store) => {
          store.revokeToken(identifier);
          return { ok: true };
        }),
      );
      return;
    }
    throw new Error("invalid command arguments");
  }
  if (command === "cleanup") {
    const o = options(parsed, ["data-dir"]);
    if (parsed.positional.length) throw new Error("unexpected arguments");
    print(withStore(dataDir(o), (store) => new NativeAssetService(store).cleanup()));
    return;
  }
  throw new Error("unknown command");
}

import { NativeAssetService } from "./api.ts";

if (import.meta.main) {
  run(process.argv.slice(2)).catch(() => {
    process.stderr.write(
      "shlook-server: command failed; check arguments and initialized data directory\n",
    );
    process.exitCode = 1;
  });
}
