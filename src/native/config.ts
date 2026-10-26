import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";

export type NativeConfig = {
  version: 1;
  origin: string;
  aliases: string[];
  allowLoopbackHttp: boolean;
};

function origin(value: string, allowHttp: boolean): string {
  const parsed = new URL(value);
  if (
    parsed.origin !== value ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("origin must be an absolute origin");
  if (
    parsed.protocol !== "https:" &&
    !(
      allowHttp &&
      parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
    )
  )
    throw new Error("origin must use HTTPS");
  return parsed.origin;
}

export function validateConfig(input: NativeConfig): NativeConfig {
  if (input.version !== 1 || typeof input.allowLoopbackHttp !== "boolean")
    throw new Error("invalid config");
  const canonical = origin(input.origin, input.allowLoopbackHttp);
  const aliases = input.aliases.map((item) => origin(item, input.allowLoopbackHttp));
  if (new Set([canonical, ...aliases]).size !== aliases.length + 1)
    throw new Error("duplicate origin");
  return { version: 1, origin: canonical, aliases, allowLoopbackHttp: input.allowLoopbackHttp };
}

export function prepareDataDirectory(path: string): string {
  if (!isAbsolute(path)) throw new Error("data directory must be absolute");
  const absolute = resolve(path);
  const components = absolute.split("/").filter(Boolean);
  let cursor = "/";
  for (const component of components) {
    cursor = resolve(cursor, component);
    try {
      if (
        lstatSync(cursor).isSymbolicLink() &&
        !(cursor === "/var" && realpathSync(cursor) === "/private/var")
      )
        throw new Error("unsafe symlinked data path");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe data directory");
  if (typeof process.getuid !== "function" || stat.uid !== process.getuid())
    throw new Error("data directory is not owned by current user");
  chmodSync(absolute, 0o700);
  return absolute;
}

export function initConfig(path: string, input: NativeConfig): NativeConfig {
  const dir = prepareDataDirectory(path);
  const config = validateConfig(input);
  const filename = resolve(dir, "server.json");
  try {
    lstatSync(filename);
    throw new Error("data directory is already initialized");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  writeFileSync(filename, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return config;
}

export function loadConfig(path: string): NativeConfig {
  const dir = prepareDataDirectory(path);
  const file = resolve(dir, "server.json");
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe config file");
  if (stat.uid !== process.getuid?.()) throw new Error("config is not owned by current user");
  chmodSync(file, 0o600);
  return validateConfig(JSON.parse(readFileSync(file, "utf8")) as NativeConfig);
}
