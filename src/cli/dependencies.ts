import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readConnectionToken } from "./connection.ts";
import type { CliDependencies } from "./types.ts";
import type { SetupCommandOptions } from "../cli-setup-runtime.ts";

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export function isolatedCommandEnvironment(
  explicit: Readonly<Record<string, string | undefined>> = {},
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(explicit).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function commandRunner(
  command: string,
  args: string[],
  options: SetupCommandOptions,
): Promise<{ code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: isolatedCommandEnvironment(options.env),
      stdio: [options.input === undefined ? "ignore" : "pipe", "ignore", "ignore"],
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code: code ?? 1 }));
    if (options.input !== undefined) {
      child.stdin?.once("error", reject);
      child.stdin?.end(options.input);
    }
  });
}

function resolvePinnedWrangler(): string {
  const packagePath = createRequire(import.meta.url).resolve("wrangler/package.json");
  return join(dirname(packagePath), "bin", "wrangler.js");
}

export function defaultCliDependencies(): CliDependencies {
  return {
    cwd: process.cwd(),
    packageRoot: PACKAGE_ROOT,
    nodeExecutable: process.execPath,
    wranglerPath: resolvePinnedWrangler(),
    env: process.env,
    fetch: globalThis.fetch,
    runCommand: commandRunner,
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
    readSecretInput: () => readConnectionToken(process.stdin, process.stderr),
    currentUid: () => process.getuid?.(),
  };
}

export { PACKAGE_ROOT, resolvePinnedWrangler };
