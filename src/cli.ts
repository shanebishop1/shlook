#!/usr/bin/env node
import { parseCliArguments } from "./cli/arguments.ts";
import { defaultCliDependencies, isolatedCommandEnvironment } from "./cli/dependencies.ts";
import { dispatch } from "./cli/dispatch.ts";
import { normalizeCliError } from "./cli/errors.ts";
import { sanitizeCliValue } from "./cli-files.ts";
import type { CliDependencies } from "./cli/types.ts";
import { readConnectionToken } from "./cli/connection.ts";

export type { CliDependencies, ConnectionTokenInput, ConnectionTokenPrompt } from "./cli/types.ts";
export { isolatedCommandEnvironment, readConnectionToken };

export async function runCli(
  argv: string[],
  dependencies: CliDependencies = defaultCliDependencies(),
): Promise<number> {
  let command = argv.find((value) => !value.startsWith("-")) ?? "unknown";
  let json = argv.includes("--json");
  try {
    const parsed = dependencies.parseArguments?.(argv) ?? parseCliArguments(argv);
    json = parsed.options.json ?? false;
    command = parsed.positionals[0] ?? "unknown";
    const result = await dispatch(parsed.positionals, parsed.options, dependencies);
    const data = result.allowSecrets ? result.data : sanitizeCliValue(result.data);
    dependencies.stdout(
      `${JSON.stringify({ ok: true, command: result.command, data }, null, json ? 0 : 2)}\n`,
    );
    return result.exitCode ?? 0;
  } catch (cause) {
    const error = normalizeCliError(cause);
    const output = {
      ok: false,
      command,
      error: {
        code: error.code,
        message: error.message,
        ...(error.status === undefined ? {} : { status: error.status }),
        ...(error.details === undefined ? {} : { details: sanitizeCliValue(error.details) }),
      },
    };
    dependencies.stderr(json ? `${JSON.stringify(output)}\n` : `shlook: ${error.message}\n`);
    return error.exitCode;
  }
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2));
