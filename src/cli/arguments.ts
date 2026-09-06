import { parseArgs } from "node:util";

import { CliError } from "./errors.ts";
import type { CliOptions } from "./types.ts";

export function parseCliArguments(argv: string[]): {
  positionals: string[];
  options: CliOptions;
} {
  try {
    const { positionals, values } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean" },
        plan: { type: "boolean" },
        apply: { type: "boolean" },
        domain: { type: "string" },
        "owner-email": { type: "string" },
        "account-id": { type: "string" },
        "show-connection-token": { type: "boolean" },
        "adopt-existing": { type: "boolean" },
        entrypoint: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        offset: { type: "string" },
      },
    });
    return {
      positionals,
      options: {
        json: values.json,
        plan: values.plan,
        apply: values.apply,
        domain: values.domain,
        ownerEmail: values["owner-email"],
        accountId: values["account-id"],
        showConnectionToken: values["show-connection-token"],
        adoptExisting: values["adopt-existing"],
        entrypoint: values.entrypoint,
        name: values.name,
        description: values.description,
        offset: values.offset,
      },
    };
  } catch {
    throw new CliError("usage_error", "invalid arguments");
  }
}
