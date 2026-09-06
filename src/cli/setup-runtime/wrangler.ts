import { dirname, join } from "node:path";

import type { ApplySetupResult, SetupInput } from "../../cli-setup.ts";
import {
  OWNER_FILE_MODE,
  assertCanonicalPathComponents,
  atomicReplaceOwnerFile,
} from "../storage/owner-files.ts";

import type { SetupRuntimeDependencies } from "./dependencies.ts";
import { secretStorageFailure, SetupRuntimeError } from "./errors.ts";
import { setupRuntimeFileSystem } from "./filesystem.ts";
import { resolveSetupConfigPath } from "./paths.ts";
import { UNSAFE_SETUP_STATE_PATH, validTemporaryId } from "./state-files.ts";

function setupConfig(input: SetupInput, result: ApplySetupResult, packageRoot: string): string {
  const origins = result.origins;
  const config = {
    name: "shlook",
    main: join(packageRoot, "src", "index.ts"),
    compatibility_date: "2026-08-26",
    account_id: result.account.id,
    workers_dev: false,
    preview_urls: false,
    routes: Object.values(origins).map((origin) => ({
      pattern: new URL(origin).hostname,
      custom_domain: true,
    })),
    vars: {
      SHLOOK_OWNER_ORIGIN: origins.owner,
      SHLOOK_PRIVATE_ORIGIN: origins.private,
      SHLOOK_PUBLIC_ORIGIN: origins.public,
      SHLOOK_SHARE_ORIGIN: origins.share,
      SHLOOK_OWNER_EMAIL: input.ownerEmail,
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: result.resources.d1.name,
        database_id: result.resources.d1.id,
        migrations_dir: join(packageRoot, "migrations"),
      },
    ],
    r2_buckets: [{ binding: "ASSETS", bucket_name: result.resources.r2.name }],
    triggers: { crons: ["*/5 * * * *"] },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

export async function writeSetupConfig(
  input: SetupInput,
  result: ApplySetupResult,
  dependencies: SetupRuntimeDependencies,
): Promise<string> {
  let path: string;
  try {
    path = resolveSetupConfigPath(dependencies.env, dependencies.home);
  } catch {
    throw new SetupRuntimeError(
      "setup_configuration_write_failed",
      "unable to write the setup configuration",
    );
  }
  const id = validTemporaryId(dependencies);
  if (id === undefined) {
    throw new SetupRuntimeError(
      "setup_configuration_write_failed",
      "unable to write the setup configuration",
    );
  }
  const temporaryPath = join(dirname(path), `.wrangler.json.${id}`);
  try {
    await atomicReplaceOwnerFile({
      path,
      temporaryPath,
      data: () => setupConfig(input, result, dependencies.packageRoot),
      fs: setupRuntimeFileSystem(dependencies),
      unsafePathMessage: UNSAFE_SETUP_STATE_PATH,
      enforceDirectoryMode: true,
      validateTemporaryPath: true,
      cleanup: "always-on-failure",
    });
    return path;
  } catch {
    throw new SetupRuntimeError(
      "setup_configuration_write_failed",
      "unable to write the setup configuration",
    );
  }
}

export function bootstrapToken(env: Readonly<Record<string, string | undefined>>): string {
  const value = env.CLOUDFLARE_API_TOKEN ?? env.SHLOOK_CF_TOKEN;
  if (value === undefined) {
    throw new SetupRuntimeError("setup_command_failed", "unable to authenticate Wrangler setup");
  }
  return value;
}

export async function runWrangler(
  dependencies: SetupRuntimeDependencies,
  args: string[],
  env: Readonly<Record<string, string | undefined>>,
  stage: string,
  input?: string,
): Promise<void> {
  let result: { code: number };
  try {
    result = await dependencies.runCommand(
      dependencies.nodeExecutable,
      [dependencies.wranglerPath, ...args],
      {
        cwd: dependencies.packageRoot,
        env,
        ...(input === undefined ? {} : { input }),
      },
    );
  } catch {
    throw new SetupRuntimeError("setup_command_failed", `setup failed while ${stage}`);
  }
  if (result.code !== 0) {
    throw new SetupRuntimeError("setup_command_failed", `setup failed while ${stage}`);
  }
}

export async function deployWithSecretFile(
  dependencies: SetupRuntimeDependencies,
  configPath: string,
  environment: Readonly<Record<string, string | undefined>>,
  encryptionKey: string,
): Promise<void> {
  const fs = setupRuntimeFileSystem(dependencies);
  const id = validTemporaryId(dependencies);
  if (id === undefined) throw secretStorageFailure();
  const path = join(dirname(configPath), `.deploy-secrets.${id}.json`);
  let created = false;
  let failure: unknown;
  try {
    await assertCanonicalPathComponents(path, fs, UNSAFE_SETUP_STATE_PATH);
    await fs.writeFile(
      path,
      `${JSON.stringify({ SHLOOK_SECRET_ENCRYPTION_KEY: encryptionKey })}\n`,
      {
        encoding: "utf8",
        flag: "wx",
        mode: OWNER_FILE_MODE,
      },
    );
    created = true;
    await runWrangler(
      dependencies,
      ["deploy", "--strict", "--config", configPath, "--secrets-file", path],
      environment,
      "deploying the Worker with its encryption secret",
    );
  } catch (cause) {
    failure = cause instanceof SetupRuntimeError ? cause : secretStorageFailure();
  } finally {
    if (created) {
      try {
        await fs.unlink(path);
      } catch {
        if (failure === undefined) failure = secretStorageFailure();
      }
    }
  }
  if (failure !== undefined) throw failure;
}
