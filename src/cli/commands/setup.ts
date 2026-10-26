import {
  decodeConnectionCredential,
  encodeConnectionCredential,
  loadConnectionCredential,
  persistConnectionCredential,
  loadProfileCredential,
  type ConnectionCredential,
} from "../../cli-connection.ts";
import { dirname, join } from "node:path";
import type { SetupInput } from "../../cli-setup.ts";
import { applySetupRuntime, planSetupRuntime } from "../../cli-setup-runtime.ts";

import { CliError } from "../errors.ts";
import { PACKAGE_ROOT, resolvePinnedWrangler } from "../dependencies.ts";
import type { CliDependencies, CliOptions } from "../types.ts";
import { defaultOrigins } from "../origins.ts";
import {
  loadProfileConfig,
  profileConfigPath,
  effectiveTokenEnv,
  normalizedTokenEnv,
  saveProfileConfig,
  validateProfileConfig,
  type CloudflareProfile,
} from "../profiles.ts";

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

export function setupRuntimeDependencies(
  dependencies: CliDependencies,
  named?: {
    name: string;
    profile?: CloudflareProfile;
    expected: ReturnType<typeof defaultOrigins>;
    credential?: ConnectionCredential;
  },
) {
  let persistedNamed: ConnectionCredential | undefined;
  return {
    ...(named === undefined ? {} : { connectionOrigins: named.expected }),
    env: dependencies.env,
    fetch: dependencies.fetch,
    packageRoot: dependencies.packageRoot ?? PACKAGE_ROOT,
    nodeExecutable: dependencies.nodeExecutable ?? process.execPath,
    wranglerPath: dependencies.wranglerPath ?? resolvePinnedWrangler(),
    runCommand: dependencies.runCommand,
    loadConnection: async () => {
      if (named !== undefined) {
        if (persistedNamed !== undefined) return persistedNamed;
        if (named.credential !== undefined) return named.credential;
        throw new Error("named setup has no stored credential");
      }
      return (
        (await dependencies.loadConnection?.()) ??
        loadConnectionCredential({ env: dependencies.env })
      );
    },
    persistConnection: async (credential: ConnectionCredential) => {
      if (named === undefined) {
        return (
          (await dependencies.persistConnection?.(credential)) ??
          persistConnectionCredential(credential, {
            env: dependencies.env,
            currentUid: dependencies.currentUid,
          })
        );
      }
      if (credential.domain !== new URL(named.expected.owner).hostname.replace(/^shlook\./, "")) {
        throw new Error("setup credential topology does not match the selected instance");
      }
      const bound = { ...credential, origins: named.expected };
      const token = encodeConnectionCredential(bound);
      if (dependencies.saveProfileCredential === undefined)
        throw new Error("named credential storage unavailable");
      await dependencies.saveProfileCredential(
        named.name,
        "cloudflare",
        named.expected.owner,
        token,
      );
      persistedNamed = bound;
      const config = await (dependencies.loadProfileConfiguration?.() ??
        loadProfileConfig(dependencies));
      config.instances[named.name] = {
        type: "cloudflare",
        url: named.expected.owner,
        origins: {
          private: named.expected.private,
          public: named.expected.public,
          share: named.expected.share,
        },
        ...(named.profile?.token_env ? { token_env: named.profile.token_env } : {}),
      };
      const validated = validateProfileConfig(config);
      if (dependencies.saveProfileConfiguration !== undefined)
        await dependencies.saveProfileConfiguration(validated);
      else await saveProfileConfig(dependencies, validated);
      return join(dirname(profileConfigPath(dependencies)), "credentials.json");
    },
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
  let named: Parameters<typeof setupRuntimeDependencies>[1];
  if (options.instance !== undefined) {
    const config = await (dependencies.loadProfileConfiguration?.() ??
      loadProfileConfig(dependencies));
    const existing = config.instances[options.instance];
    if (existing?.type === "native")
      throw new CliError(
        "unsupported_operation",
        "Cloudflare setup cannot target a native instance",
      );
    const expected = defaultOrigins(input.domain);
    if (
      existing !== undefined &&
      (existing.url !== expected.owner ||
        existing.origins.private !== expected.private ||
        existing.origins.public !== expected.public ||
        existing.origins.share !== expected.share)
    )
      throw new CliError(
        "invalid_configuration",
        "setup topology does not match the selected Cloudflare instance",
      );
    const tokenEnv = existing
      ? effectiveTokenEnv(options.instance, existing)
      : normalizedTokenEnv(options.instance);
    const environmentToken = dependencies.env[tokenEnv];
    let savedToken: string | undefined;
    if (environmentToken === undefined) {
      try {
        savedToken = await (dependencies.loadProfileCredential?.(
          options.instance,
          "cloudflare",
          expected.owner,
        ) ??
          loadProfileCredential(options.instance, "cloudflare", expected.owner, {
            env: dependencies.env,
            currentUid: dependencies.currentUid,
          }));
      } catch {
        throw new CliError(
          "invalid_credential",
          "saved named setup credential is invalid or unavailable",
        );
      }
    }
    const selectedToken = environmentToken ?? savedToken;
    let credential: ConnectionCredential | undefined;
    if (selectedToken !== undefined) {
      try {
        credential = decodeConnectionCredential(selectedToken);
      } catch {
        throw new CliError("invalid_credential", "named setup credential is invalid");
      }
      if (
        credential.origins?.owner !== expected.owner ||
        credential.origins.private !== expected.private ||
        credential.origins.public !== expected.public ||
        credential.origins.share !== expected.share ||
        credential.domain !== input.domain
      )
        throw new CliError(
          "invalid_credential",
          "named setup credential does not match the selected topology",
        );
    } else if (existing !== undefined) {
      throw new CliError(
        "auth_required",
        `authentication required for instance ${options.instance}; set ${tokenEnv} or run connect --instance ${options.instance}`,
      );
    }
    named = {
      name: options.instance,
      profile: existing,
      expected,
      ...(credential === undefined ? {} : { credential }),
    };
  }
  if (options.plan) {
    return {
      data:
        (await dependencies.planSetup?.(input)) ??
        (await planSetupRuntime(input, setupRuntimeDependencies(dependencies, named))),
    };
  }
  const applyInput = { ...input, showConnectionToken: options.showConnectionToken ?? false };
  const data =
    (await dependencies.applySetup?.(applyInput)) ??
    (await applySetupRuntime(applyInput, setupRuntimeDependencies(dependencies, named)));
  return {
    data: options.showConnectionToken ? data : omitConnectionToken(data),
    allowSecrets: options.showConnectionToken === true,
  };
}
