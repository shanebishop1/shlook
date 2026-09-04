import { randomBytes as nodeRandomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, parse as parsePath } from "node:path";

import {
  applySetup,
  planSetup,
  type ApplySetupInput,
  type ApplySetupResult,
  type CloudflareSetupDependencies,
  type SetupInput,
  type SetupPlan,
} from "./cli-setup.ts";
import { encodeConnectionCredential, type ConnectionCredential } from "./cli-connection.ts";

const CONFIG_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const VERIFY_ATTEMPTS = 6;
const VERIFY_DELAY_MS = 2_000;
const DEPLOYMENT_SECRET_FILE = "secret-encryption-key";

export interface SetupCommandOptions {
  cwd: string;
  env?: Readonly<Record<string, string | undefined>>;
  input?: string;
}

export type SetupCommandRunner = (
  command: string,
  args: string[],
  options: SetupCommandOptions,
) => Promise<{ code: number }>;

export interface SetupRuntimeFileSystem {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  chmod(path: string, mode: number): Promise<unknown>;
  writeFile(
    path: string,
    data: string,
    options: { encoding: "utf8"; flag: "wx"; mode: number },
  ): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  unlink(path: string): Promise<unknown>;
  link(from: string, to: string): Promise<unknown>;
  open(path: string, flags: number): Promise<SetupRuntimeFileHandle>;
}

export interface SetupRuntimeFileHandle {
  stat(): Promise<{
    isFile(): boolean;
    mode: number;
    size: number;
    uid: number;
  }>;
  readFile(options: { encoding: "utf8" }): Promise<string>;
  close(): Promise<void>;
}

export interface SetupRuntimeDependencies extends CloudflareSetupDependencies {
  packageRoot: string;
  nodeExecutable: string;
  wranglerPath: string;
  runCommand: SetupCommandRunner;
  loadConnection?: () => Promise<ConnectionCredential>;
  persistConnection: (credential: ConnectionCredential) => Promise<string>;
  planCloudflareSetup?: (
    input: SetupInput,
    dependencies: CloudflareSetupDependencies,
  ) => Promise<SetupPlan>;
  applyCloudflareSetup?: (
    input: ApplySetupInput,
    dependencies: CloudflareSetupDependencies,
  ) => Promise<ApplySetupResult>;
  fs?: SetupRuntimeFileSystem;
  home?: () => string;
  randomBytes?: (size: number) => Uint8Array;
  randomId?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface SetupRuntimeInput extends SetupInput {
  showConnectionToken?: boolean;
}

export interface SetupRuntimeResult {
  mode: "apply";
  account: ApplySetupResult["account"];
  zone: ApplySetupResult["zone"];
  origins: ApplySetupResult["origins"];
  resources: ApplySetupResult["resources"];
  config: { path: string };
  deployment: { migrationsApplied: true; deployed: true; secretStored: true };
  verification: { ownerHealth: true; privateAccess: true };
  connection: { stored: true; path: string };
  connectionToken?: string;
}

export type SetupRuntimeErrorCode =
  | "setup_configuration_write_failed"
  | "setup_command_failed"
  | "setup_secret_generation_failed"
  | "setup_secret_storage_failed"
  | "setup_verification_failed"
  | "connection_persistence_failed"
  | "service_token_secret_unavailable";

export class SetupRuntimeError extends Error {
  readonly code: SetupRuntimeErrorCode;

  constructor(code: SetupRuntimeErrorCode, message: string) {
    super(message);
    this.name = "SetupRuntimeError";
    this.code = code;
  }
}

const defaultFileSystem: SetupRuntimeFileSystem = {
  mkdir,
  chmod,
  writeFile,
  rename,
  unlink,
  link,
  open,
};

function safeBasePath(value: string): string {
  if (value.includes("\0") || !isAbsolute(value)) {
    throw new Error("invalid setup configuration path");
  }
  const normalized = normalize(value);
  const withoutTrailingSeparators = value.replace(/[\\/]+$/, "") || parsePath(value).root;
  if (normalized !== withoutTrailingSeparators || normalized === parsePath(normalized).root) {
    throw new Error("invalid setup configuration path");
  }
  return normalized;
}

export function resolveSetupConfigPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: () => string = homedir,
): string {
  const descriptor = Object.getOwnPropertyDescriptor(env, "XDG_CONFIG_HOME");
  const xdg =
    descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  const base =
    xdg === undefined || xdg === "" ? join(safeBasePath(home()), ".config") : safeBasePath(xdg);
  return join(base, "shlook", "deployment", "wrangler.json");
}

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

async function writeSetupConfig(
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
  const directory = dirname(path);
  const id = (dependencies.randomId ?? randomUUID)();
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) {
    throw new SetupRuntimeError(
      "setup_configuration_write_failed",
      "unable to write the setup configuration",
    );
  }
  const temporaryPath = join(directory, `.wrangler.json.${id}`);
  const fs = dependencies.fs ?? defaultFileSystem;
  try {
    await fs.mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    await fs.chmod(directory, DIRECTORY_MODE);
    await fs.writeFile(temporaryPath, setupConfig(input, result, dependencies.packageRoot), {
      encoding: "utf8",
      flag: "wx",
      mode: CONFIG_MODE,
    });
    await fs.rename(temporaryPath, path);
    await fs.chmod(path, CONFIG_MODE);
    return path;
  } catch {
    try {
      await fs.unlink(temporaryPath);
    } catch {
      // The temporary file may not exist or may already have been renamed.
    }
    throw new SetupRuntimeError(
      "setup_configuration_write_failed",
      "unable to write the setup configuration",
    );
  }
}

function bootstrapToken(env: Readonly<Record<string, string | undefined>>): string {
  const value = env.CLOUDFLARE_API_TOKEN ?? env.SHLOOK_CF_TOKEN;
  if (value === undefined) {
    throw new SetupRuntimeError("setup_command_failed", "unable to authenticate Wrangler setup");
  }
  return value;
}

function storageFailure(): SetupRuntimeError {
  return new SetupRuntimeError(
    "setup_secret_storage_failed",
    "unable to load or save the deployment encryption secret",
  );
}

function errorCode(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(cause, "code");
  return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}

function validateDeploymentSecret(raw: string): string {
  const value = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (
    !/^[A-Za-z0-9+/]{43}=$/.test(value) ||
    Buffer.from(value, "base64").byteLength !== 32 ||
    Buffer.from(value, "base64").toString("base64") !== value ||
    (raw !== value && raw !== `${value}\n`)
  ) {
    throw storageFailure();
  }
  return value;
}

async function loadDeploymentSecret(
  path: string,
  fs: SetupRuntimeFileSystem,
): Promise<string | undefined> {
  let handle: SetupRuntimeFileHandle;
  try {
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return undefined;
    throw storageFailure();
  }

  let value: string;
  try {
    const metadata = await handle.stat();
    const currentUid = process.getuid?.();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o777) !== CONFIG_MODE ||
      ![44, 45].includes(metadata.size) ||
      (currentUid !== undefined && metadata.uid !== currentUid)
    ) {
      throw storageFailure();
    }
    value = validateDeploymentSecret(await handle.readFile({ encoding: "utf8" }));
  } catch (cause) {
    await handle.close().catch(() => undefined);
    if (cause instanceof SetupRuntimeError) throw cause;
    throw storageFailure();
  }
  try {
    await handle.close();
  } catch {
    throw storageFailure();
  }
  return value;
}

async function deploymentConfigExists(path: string, fs: SetupRuntimeFileSystem): Promise<boolean> {
  let handle: SetupRuntimeFileHandle;
  try {
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return false;
    throw storageFailure();
  }
  try {
    if (!(await handle.stat()).isFile()) throw storageFailure();
  } catch (cause) {
    await handle.close().catch(() => undefined);
    if (cause instanceof SetupRuntimeError) throw cause;
    throw storageFailure();
  }
  try {
    await handle.close();
  } catch {
    throw storageFailure();
  }
  return true;
}

function generateDeploymentSecret(dependencies: SetupRuntimeDependencies): string {
  let bytes: Uint8Array;
  try {
    bytes = (dependencies.randomBytes ?? nodeRandomBytes)(32);
  } catch {
    throw new SetupRuntimeError(
      "setup_secret_generation_failed",
      "unable to generate the encryption secret",
    );
  }
  if (bytes.byteLength !== 32) {
    throw new SetupRuntimeError(
      "setup_secret_generation_failed",
      "unable to generate the encryption secret",
    );
  }
  return Buffer.from(bytes).toString("base64");
}

export async function loadOrCreateDeploymentSecret(
  dependencies: SetupRuntimeDependencies,
  allowCreate = true,
): Promise<string> {
  let configPath: string;
  try {
    configPath = resolveSetupConfigPath(dependencies.env, dependencies.home);
  } catch {
    throw storageFailure();
  }
  const path = join(dirname(configPath), DEPLOYMENT_SECRET_FILE);
  const directory = dirname(path);
  const fs = dependencies.fs ?? defaultFileSystem;
  try {
    await fs.mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    await fs.chmod(directory, DIRECTORY_MODE);
  } catch {
    throw storageFailure();
  }

  const existing = await loadDeploymentSecret(path, fs);
  if (existing !== undefined) return existing;
  if (!allowCreate || (await deploymentConfigExists(configPath, fs))) throw storageFailure();

  const secret = generateDeploymentSecret(dependencies);
  const id = (dependencies.randomId ?? randomUUID)();
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw storageFailure();
  const temporaryPath = join(directory, `.${DEPLOYMENT_SECRET_FILE}.${id}`);
  let temporaryCreated = false;
  try {
    await fs.writeFile(temporaryPath, `${secret}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: CONFIG_MODE,
    });
    temporaryCreated = true;
    try {
      await fs.link(temporaryPath, path);
    } catch (cause) {
      if (errorCode(cause) !== "EEXIST") throw cause;
      const winner = await loadDeploymentSecret(path, fs);
      if (winner === undefined) throw storageFailure();
      return winner;
    }
    await fs.chmod(path, CONFIG_MODE);
    return secret;
  } catch (cause) {
    if (cause instanceof SetupRuntimeError) throw cause;
    throw storageFailure();
  } finally {
    if (temporaryCreated) {
      try {
        await fs.unlink(temporaryPath);
      } catch {
        // The owner-only directory contains a random, non-authoritative hard link at worst.
      }
    }
  }
}

async function runWrangler(
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

function accessHeaders(credential: ConnectionCredential): Headers {
  return new Headers({
    "CF-Access-Client-Id": credential.accessClientId,
    "CF-Access-Client-Secret": credential.accessClientSecret,
    "x-shlook-client": "1",
  });
}

async function reachesWorker(
  dependencies: SetupRuntimeDependencies,
  url: string,
  expectedStatus: number,
  credential: ConnectionCredential,
): Promise<boolean> {
  try {
    const response = await dependencies.fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: accessHeaders(credential),
    });
    const ok = response.status === expectedStatus;
    await response.body?.cancel().catch(() => undefined);
    return ok;
  } catch {
    return false;
  }
}

async function verifyDeployment(
  result: ApplySetupResult,
  credential: ConnectionCredential,
  dependencies: SetupRuntimeDependencies,
): Promise<void> {
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1) {
    const owner = await reachesWorker(
      dependencies,
      `${result.origins.owner}/health`,
      200,
      credential,
    );
    const privateAccess = await reachesWorker(
      dependencies,
      `${result.origins.private}/`,
      404,
      credential,
    );
    if (owner && privateAccess) return;
    if (attempt < VERIFY_ATTEMPTS) await sleep(VERIFY_DELAY_MS);
  }
  throw new SetupRuntimeError(
    "setup_verification_failed",
    "deployed shlook access verification failed",
  );
}

async function storedCredential(
  input: SetupInput,
  dependencies: SetupRuntimeDependencies,
): Promise<ConnectionCredential | undefined> {
  if (dependencies.loadConnection === undefined) return undefined;
  try {
    const credential = await dependencies.loadConnection();
    return credential.domain === input.domain ? credential : undefined;
  } catch {
    return undefined;
  }
}

export async function planSetupRuntime(
  input: SetupInput,
  dependencies: SetupRuntimeDependencies,
): Promise<SetupPlan> {
  return (dependencies.planCloudflareSetup ?? planSetup)(input, {
    env: dependencies.env,
    fetch: dependencies.fetch,
  });
}

export async function applySetupRuntime(
  input: SetupRuntimeInput,
  dependencies: SetupRuntimeDependencies,
): Promise<SetupRuntimeResult> {
  const existing = await storedCredential(input, dependencies);
  const encryptionKey = await loadOrCreateDeploymentSecret(dependencies, existing === undefined);
  const result = await (dependencies.applyCloudflareSetup ?? applySetup)(
    {
      domain: input.domain,
      ownerEmail: input.ownerEmail,
      ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
      ...(existing === undefined
        ? {}
        : {
            existingServiceToken: {
              clientId: existing.accessClientId,
              clientSecret: existing.accessClientSecret,
            },
          }),
    },
    { env: dependencies.env, fetch: dependencies.fetch },
  );
  const serviceToken =
    result.createdServiceTokenCredentials ??
    (existing === undefined
      ? undefined
      : { clientId: existing.accessClientId, clientSecret: existing.accessClientSecret });
  if (serviceToken === undefined) {
    throw new SetupRuntimeError(
      "service_token_secret_unavailable",
      "the existing shlook Access service token secret cannot be recovered",
    );
  }
  const credential: ConnectionCredential = {
    domain: input.domain,
    accessClientId: serviceToken.clientId,
    accessClientSecret: serviceToken.clientSecret,
  };

  const configPath = await writeSetupConfig(input, result, dependencies);
  const commandEnvironment = {
    CLOUDFLARE_API_TOKEN: bootstrapToken(dependencies.env),
    CLOUDFLARE_ACCOUNT_ID: result.account.id,
  };
  await runWrangler(
    dependencies,
    ["d1", "migrations", "apply", result.resources.d1.name, "--remote", "--config", configPath],
    commandEnvironment,
    "applying database migrations",
  );
  await runWrangler(
    dependencies,
    ["deploy", "--config", configPath],
    commandEnvironment,
    "deploying the Worker",
  );
  await runWrangler(
    dependencies,
    ["secret", "put", "SHLOOK_SECRET_ENCRYPTION_KEY", "--config", configPath],
    commandEnvironment,
    "storing the encryption secret",
    `${encryptionKey}\n`,
  );
  await verifyDeployment(result, credential, dependencies);

  let connectionPath: string;
  try {
    connectionPath = await dependencies.persistConnection(credential);
  } catch {
    throw new SetupRuntimeError(
      "connection_persistence_failed",
      "unable to save connection credential",
    );
  }

  return {
    mode: "apply",
    account: result.account,
    zone: result.zone,
    origins: result.origins,
    resources: result.resources,
    config: { path: configPath },
    deployment: { migrationsApplied: true, deployed: true, secretStored: true },
    verification: { ownerHealth: true, privateAccess: true },
    connection: { stored: true, path: connectionPath },
    ...(input.showConnectionToken
      ? { connectionToken: encodeConnectionCredential(credential) }
      : {}),
  };
}
