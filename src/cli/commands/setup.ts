import {
  loadConnectionCredential,
  persistConnectionCredential,
  type ConnectionCredential,
} from "../../cli-connection.ts";
import type { SetupInput } from "../../cli-setup.ts";
import { applySetupRuntime, planSetupRuntime } from "../../cli-setup-runtime.ts";

import { CliError } from "../errors.ts";
import { PACKAGE_ROOT, resolvePinnedWrangler } from "../dependencies.ts";
import type { CliDependencies, CliOptions } from "../types.ts";

function setupInput(options: CliOptions, dependencies: CliDependencies): SetupInput {
  const domain = options.domain ?? dependencies.env.SHLOOK_DOMAIN;
  const ownerEmail = options.ownerEmail ?? dependencies.env.SHLOOK_OWNER_EMAIL;
  const accountId = options.accountId ?? dependencies.env.SHLOOK_ACCOUNT_ID;
  if (domain === undefined)
    throw new CliError("usage_error", "setup requires --domain or SHLOOK_DOMAIN");
  if (ownerEmail === undefined)
    throw new CliError("usage_error", "setup requires --owner-email or SHLOOK_OWNER_EMAIL");
  return {
    domain,
    ownerEmail,
    ...(accountId === undefined ? {} : { accountId }),
    ...(options.adoptExisting === true ? { adoptExisting: true } : {}),
  };
}

function setupRuntimeDependencies(dependencies: CliDependencies) {
  return {
    env: dependencies.env,
    fetch: dependencies.fetch,
    packageRoot: dependencies.packageRoot ?? PACKAGE_ROOT,
    nodeExecutable: dependencies.nodeExecutable ?? process.execPath,
    wranglerPath: dependencies.wranglerPath ?? resolvePinnedWrangler(),
    runCommand: dependencies.runCommand,
    loadConnection: () =>
      dependencies.loadConnection?.() ?? loadConnectionCredential({ env: dependencies.env }),
    persistConnection: (credential: ConnectionCredential) =>
      dependencies.persistConnection?.(credential) ??
      persistConnectionCredential(credential, {
        env: dependencies.env,
        currentUid: dependencies.currentUid,
      }),
  };
}

function omitConnectionToken(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const { connectionToken: _connectionToken, ...safe } = value as Record<string, unknown>;
  return safe;
}

export async function setup(
  dependencies: CliDependencies,
  args: string[],
  options: CliOptions,
): Promise<{ data: unknown; allowSecrets?: boolean }> {
  if (args.length !== 0)
    throw new CliError("usage_error", "setup does not accept positional values");
  if (options.plan === options.apply) {
    throw new CliError("usage_error", "setup requires exactly one of --plan or --apply");
  }
  if (options.plan && options.showConnectionToken) {
    throw new CliError("usage_error", "--show-connection-token requires setup --apply");
  }
  const input = setupInput(options, dependencies);
  if (options.plan) {
    return {
      data:
        (await dependencies.planSetup?.(input)) ??
        (await planSetupRuntime(input, setupRuntimeDependencies(dependencies))),
    };
  }
  const applyInput = { ...input, showConnectionToken: options.showConnectionToken ?? false };
  const data =
    (await dependencies.applySetup?.(applyInput)) ??
    (await applySetupRuntime(applyInput, setupRuntimeDependencies(dependencies)));
  return {
    data: options.showConnectionToken ? data : omitConnectionToken(data),
    allowSecrets: options.showConnectionToken === true,
  };
}
