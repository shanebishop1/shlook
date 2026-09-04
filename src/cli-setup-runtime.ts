import { randomBytes as nodeRandomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, parse as parsePath } from "node:path";

import {
  applySetup,
  planSetup,
  reconcileSetupDeploymentManifest,
  type ApplySetupInput,
  type ApplySetupResult,
  type CloudflareSetupDependencies,
  type PendingServiceToken,
  type SetupDeploymentManifest,
  type SetupInput,
  type SetupPlan,
  type SetupResourceKey,
} from "./cli-setup.ts";
import { encodeConnectionCredential, type ConnectionCredential } from "./cli-connection.ts";

const CONFIG_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const VERIFY_ATTEMPTS = 6;
const VERIFY_DELAY_MS = 2_000;
const DEPLOYMENT_SECRET_FILE = "secret-encryption-key";
const DEPLOYMENT_MANIFEST_FILE = "manifest.json";
const PENDING_SERVICE_TOKEN_FILE = "pending-service-token.json";
const SERVICE_TOKEN_ROTATION_FILE = "service-token-rotation.json";
const MAX_STATE_BYTES = 65_536;

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
  reconcileCloudflareSetup?: (
    input: SetupInput & { deploymentManifest: SetupDeploymentManifest },
    dependencies: CloudflareSetupDependencies,
  ) => Promise<SetupDeploymentManifest>;
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
  deployment: { migrationsApplied: true; deployed: true; secretDeployed: true };
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
  | "setup_manifest_storage_failed"
  | "setup_pending_credentials_failed"
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const setupResourceKeys: SetupResourceKey[] = [
  "d1",
  "r2",
  "access_application_owner",
  "access_application_private",
  "access_service_token",
  "access_email_policy_owner",
  "access_email_policy_private",
  "access_service_token_policy_owner",
  "access_service_token_policy_private",
  "worker_service",
  "workers_domain_owner",
  "workers_domain_private",
  "workers_domain_public",
  "workers_domain_share",
];

interface PendingServiceTokenState extends PendingServiceToken {
  version: 1;
  domain: string;
  ownerEmail: string;
  accountId: string;
  zoneId: string;
}

interface ServiceTokenRotationState {
  version: 1;
  domain: string;
  ownerEmail: string;
  accountId: string;
  zoneId: string;
  resourceId: string;
}

function manifestFailure(): SetupRuntimeError {
  return new SetupRuntimeError(
    "setup_manifest_storage_failed",
    "unable to load or save the deployment ownership manifest",
  );
}

function pendingFailure(): SetupRuntimeError {
  return new SetupRuntimeError(
    "setup_pending_credentials_failed",
    "unable to load or save pending Access credentials",
  );
}

function statePath(dependencies: SetupRuntimeDependencies, file: string): string {
  try {
    return join(dirname(resolveSetupConfigPath(dependencies.env, dependencies.home)), file);
  } catch {
    throw file === DEPLOYMENT_MANIFEST_FILE ? manifestFailure() : pendingFailure();
  }
}

async function readOwnerFile(
  path: string,
  fs: SetupRuntimeFileSystem,
  failure: () => SetupRuntimeError,
): Promise<string | undefined> {
  let handle: SetupRuntimeFileHandle;
  try {
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return undefined;
    throw failure();
  }
  try {
    const metadata = await handle.stat();
    const currentUid = process.getuid?.();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o777) !== CONFIG_MODE ||
      metadata.size <= 0 ||
      metadata.size > MAX_STATE_BYTES ||
      (currentUid !== undefined && metadata.uid !== currentUid)
    ) {
      throw failure();
    }
    return await handle.readFile({ encoding: "utf8" });
  } catch (cause) {
    if (cause instanceof SetupRuntimeError) throw cause;
    throw failure();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function atomicWriteOwnerFile(
  path: string,
  data: string,
  dependencies: SetupRuntimeDependencies,
  failure: () => SetupRuntimeError,
): Promise<void> {
  const fs = dependencies.fs ?? defaultFileSystem;
  const directory = dirname(path);
  const id = (dependencies.randomId ?? randomUUID)();
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw failure();
  const temporaryPath = join(directory, `.${path.slice(path.lastIndexOf("/") + 1)}.${id}`);
  let created = false;
  try {
    await fs.mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    await fs.chmod(directory, DIRECTORY_MODE);
    await fs.writeFile(temporaryPath, data, {
      encoding: "utf8",
      flag: "wx",
      mode: CONFIG_MODE,
    });
    created = true;
    await fs.rename(temporaryPath, path);
    created = false;
    await fs.chmod(path, CONFIG_MODE);
  } catch {
    throw failure();
  } finally {
    if (created) await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

async function atomicCreateOwnerFile(
  path: string,
  data: string,
  dependencies: SetupRuntimeDependencies,
  failure: () => SetupRuntimeError,
): Promise<void> {
  const fs = dependencies.fs ?? defaultFileSystem;
  const directory = dirname(path);
  const id = (dependencies.randomId ?? randomUUID)();
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw failure();
  const temporaryPath = join(directory, `.${path.slice(path.lastIndexOf("/") + 1)}.${id}`);
  let created = false;
  try {
    await fs.mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    await fs.chmod(directory, DIRECTORY_MODE);
    await fs.writeFile(temporaryPath, data, {
      encoding: "utf8",
      flag: "wx",
      mode: CONFIG_MODE,
    });
    created = true;
    try {
      await fs.link(temporaryPath, path);
    } catch (cause) {
      if (errorCode(cause) !== "EEXIST") throw cause;
      const winner = await readOwnerFile(path, fs, failure);
      if (winner !== data) throw failure();
      return;
    }
    await fs.chmod(path, CONFIG_MODE);
  } catch (cause) {
    if (cause instanceof SetupRuntimeError) throw cause;
    throw failure();
  } finally {
    if (created) await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

function parseManifest(raw: string): SetupDeploymentManifest {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw manifestFailure();
  }
  if (
    !isRecord(decoded) ||
    Object.keys(decoded).length !== 6 ||
    decoded.version !== 1 ||
    typeof decoded.domain !== "string" ||
    typeof decoded.ownerEmail !== "string" ||
    typeof decoded.accountId !== "string" ||
    typeof decoded.zoneId !== "string" ||
    !isRecord(decoded.resources) ||
    Object.keys(decoded.resources).length !== setupResourceKeys.length
  )
    throw manifestFailure();
  for (const key of setupResourceKeys) {
    const value = decoded.resources[key];
    if (
      !isRecord(value) ||
      ![2, 3].includes(Object.keys(value).length) ||
      Object.keys(value).some((field) => !["action", "name", "id"].includes(field)) ||
      !["create", "adopt"].includes(String(value.action)) ||
      typeof value.name !== "string" ||
      value.name.length === 0 ||
      value.name.length > 4096 ||
      (value.id !== undefined &&
        (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 4096))
    )
      throw manifestFailure();
  }
  return decoded as unknown as SetupDeploymentManifest;
}

async function loadDeploymentManifest(
  dependencies: SetupRuntimeDependencies,
): Promise<SetupDeploymentManifest | undefined> {
  const raw = await readOwnerFile(
    statePath(dependencies, DEPLOYMENT_MANIFEST_FILE),
    dependencies.fs ?? defaultFileSystem,
    manifestFailure,
  );
  return raw === undefined ? undefined : parseManifest(raw);
}

async function saveDeploymentManifest(
  manifest: SetupDeploymentManifest,
  dependencies: SetupRuntimeDependencies,
  createOnly = false,
): Promise<void> {
  await (createOnly ? atomicCreateOwnerFile : atomicWriteOwnerFile)(
    statePath(dependencies, DEPLOYMENT_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    dependencies,
    manifestFailure,
  );
}

function parsePending(raw: string): PendingServiceTokenState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw pendingFailure();
  }
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 8 ||
    value.version !== 1 ||
    ![
      "domain",
      "ownerEmail",
      "accountId",
      "zoneId",
      "resourceId",
      "clientId",
      "clientSecret",
    ].every((key) => typeof value[key] === "string" && (value[key] as string).length > 0) ||
    Object.values(value).some((entry) => typeof entry === "string" && entry.length > 4096)
  )
    throw pendingFailure();
  return value as unknown as PendingServiceTokenState;
}

async function loadPendingServiceToken(
  dependencies: SetupRuntimeDependencies,
): Promise<PendingServiceTokenState | undefined> {
  const raw = await readOwnerFile(
    statePath(dependencies, PENDING_SERVICE_TOKEN_FILE),
    dependencies.fs ?? defaultFileSystem,
    pendingFailure,
  );
  return raw === undefined ? undefined : parsePending(raw);
}

async function savePendingServiceToken(
  pending: PendingServiceTokenState,
  dependencies: SetupRuntimeDependencies,
): Promise<void> {
  await atomicCreateOwnerFile(
    statePath(dependencies, PENDING_SERVICE_TOKEN_FILE),
    `${JSON.stringify(pending)}\n`,
    dependencies,
    pendingFailure,
  );
}

function parseServiceTokenRotation(raw: string): ServiceTokenRotationState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw pendingFailure();
  }
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 6 ||
    value.version !== 1 ||
    !["domain", "ownerEmail", "accountId", "zoneId", "resourceId"].every(
      (key) => typeof value[key] === "string" && (value[key] as string).length > 0,
    ) ||
    Object.values(value).some((entry) => typeof entry === "string" && entry.length > 4096)
  ) {
    throw pendingFailure();
  }
  return value as unknown as ServiceTokenRotationState;
}

async function loadServiceTokenRotation(
  dependencies: SetupRuntimeDependencies,
): Promise<ServiceTokenRotationState | undefined> {
  const raw = await readOwnerFile(
    statePath(dependencies, SERVICE_TOKEN_ROTATION_FILE),
    dependencies.fs ?? defaultFileSystem,
    pendingFailure,
  );
  return raw === undefined ? undefined : parseServiceTokenRotation(raw);
}

async function saveServiceTokenRotation(
  rotation: ServiceTokenRotationState,
  dependencies: SetupRuntimeDependencies,
): Promise<void> {
  await atomicCreateOwnerFile(
    statePath(dependencies, SERVICE_TOKEN_ROTATION_FILE),
    `${JSON.stringify(rotation)}\n`,
    dependencies,
    pendingFailure,
  );
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

async function deployWithSecretFile(
  dependencies: SetupRuntimeDependencies,
  configPath: string,
  environment: Readonly<Record<string, string | undefined>>,
  encryptionKey: string,
): Promise<void> {
  const fs = dependencies.fs ?? defaultFileSystem;
  const id = (dependencies.randomId ?? randomUUID)();
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw storageFailure();
  const path = join(dirname(configPath), `.deploy-secrets.${id}.json`);
  let created = false;
  let failure: unknown;
  try {
    await fs.writeFile(
      path,
      `${JSON.stringify({ SHLOOK_SECRET_ENCRYPTION_KEY: encryptionKey })}\n`,
      {
        encoding: "utf8",
        flag: "wx",
        mode: CONFIG_MODE,
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
    failure = cause instanceof SetupRuntimeError ? cause : storageFailure();
  } finally {
    if (created) {
      try {
        await fs.unlink(path);
      } catch {
        if (failure === undefined) failure = storageFailure();
      }
    }
  }
  if (failure !== undefined) throw failure;
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
  const deploymentManifest = await loadDeploymentManifest(dependencies);
  return (dependencies.planCloudflareSetup ?? planSetup)(
    {
      domain: input.domain,
      ownerEmail: input.ownerEmail,
      ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
      ...(input.adoptExisting === true ? { adoptExisting: true } : {}),
      ...(deploymentManifest === undefined ? {} : { deploymentManifest }),
    },
    {
      env: dependencies.env,
      fetch: dependencies.fetch,
    },
  );
}

function sameCredential(left: ConnectionCredential, right: ConnectionCredential): boolean {
  return (
    left.domain === right.domain &&
    left.accessClientId === right.accessClientId &&
    left.accessClientSecret === right.accessClientSecret
  );
}

function credentialFromPending(pending: PendingServiceTokenState): ConnectionCredential {
  return {
    domain: pending.domain,
    accessClientId: pending.clientId,
    accessClientSecret: pending.clientSecret,
  };
}

async function removePendingServiceToken(dependencies: SetupRuntimeDependencies): Promise<void> {
  try {
    await (dependencies.fs ?? defaultFileSystem).unlink(
      statePath(dependencies, PENDING_SERVICE_TOKEN_FILE),
    );
  } catch (cause) {
    if (errorCode(cause) !== "ENOENT") throw pendingFailure();
  }
}

async function removeServiceTokenRotation(dependencies: SetupRuntimeDependencies): Promise<void> {
  try {
    await (dependencies.fs ?? defaultFileSystem).unlink(
      statePath(dependencies, SERVICE_TOKEN_ROTATION_FILE),
    );
  } catch (cause) {
    if (errorCode(cause) !== "ENOENT") throw pendingFailure();
  }
}

async function reconcileManifest(
  input: SetupRuntimeInput,
  manifest: SetupDeploymentManifest,
  dependencies: SetupRuntimeDependencies,
): Promise<SetupDeploymentManifest> {
  const reconciled = await (
    dependencies.reconcileCloudflareSetup ?? reconcileSetupDeploymentManifest
  )(
    {
      domain: input.domain,
      ownerEmail: input.ownerEmail,
      ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
      deploymentManifest: manifest,
    },
    { env: dependencies.env, fetch: dependencies.fetch },
  );
  if (JSON.stringify(reconciled) !== JSON.stringify(manifest)) {
    await saveDeploymentManifest(reconciled, dependencies);
  }
  return reconciled;
}

function unresolvedWorkerDomains(manifest: SetupDeploymentManifest): boolean {
  return (["owner", "private", "public", "share"] as const).some(
    (surface) => manifest.resources[`workers_domain_${surface}`].id === undefined,
  );
}

function assertPendingMatchesManifest(
  pending: PendingServiceTokenState,
  manifest: SetupDeploymentManifest,
): void {
  if (
    pending.domain !== manifest.domain ||
    pending.ownerEmail !== manifest.ownerEmail ||
    pending.accountId !== manifest.accountId ||
    pending.zoneId !== manifest.zoneId ||
    (manifest.resources.access_service_token.id !== undefined &&
      manifest.resources.access_service_token.id !== pending.resourceId)
  ) {
    throw pendingFailure();
  }
}

function assertRotationMatchesManifest(
  rotation: ServiceTokenRotationState,
  manifest: SetupDeploymentManifest,
): void {
  if (
    rotation.domain !== manifest.domain ||
    rotation.ownerEmail !== manifest.ownerEmail ||
    rotation.accountId !== manifest.accountId ||
    rotation.zoneId !== manifest.zoneId ||
    manifest.resources.access_service_token.id !== rotation.resourceId
  ) {
    throw pendingFailure();
  }
}

async function verifiedPersistedConnection(
  credential: ConnectionCredential,
  dependencies: SetupRuntimeDependencies,
): Promise<string> {
  let path: string;
  try {
    path = await dependencies.persistConnection(credential);
    if (dependencies.loadConnection === undefined) throw new Error("connection loader unavailable");
    const loaded = await dependencies.loadConnection();
    if (!sameCredential(loaded, credential)) throw new Error("persisted credential mismatch");
  } catch {
    throw new SetupRuntimeError(
      "connection_persistence_failed",
      "unable to save and verify connection credential",
    );
  }
  return path;
}

export async function applySetupRuntime(
  input: SetupRuntimeInput,
  dependencies: SetupRuntimeDependencies,
): Promise<SetupRuntimeResult> {
  const existing = await storedCredential(input, dependencies);
  let manifest = await loadDeploymentManifest(dependencies);
  let pending = await loadPendingServiceToken(dependencies);
  let rotation = await loadServiceTokenRotation(dependencies);
  if (rotation !== undefined) {
    if (manifest === undefined) throw pendingFailure();
    assertRotationMatchesManifest(rotation, manifest);
    if (pending !== undefined && pending.resourceId !== rotation.resourceId) throw pendingFailure();
  }
  const mayCreateDeploymentSecret =
    manifest === undefined ||
    pending !== undefined ||
    rotation !== undefined ||
    manifest.resources.access_service_token.id === undefined;
  if (pending !== undefined) {
    if (manifest === undefined) throw pendingFailure();
    assertPendingMatchesManifest(pending, manifest);
    const pendingCredential = credentialFromPending(pending);
    if (existing !== undefined && !sameCredential(existing, pendingCredential)) {
      throw pendingFailure();
    }
    if (manifest.resources.access_service_token.id === undefined) {
      manifest = {
        ...manifest,
        resources: {
          ...manifest.resources,
          access_service_token: {
            ...manifest.resources.access_service_token,
            id: pending.resourceId,
          },
        },
      };
      await saveDeploymentManifest(manifest, dependencies);
    }
  }
  if (manifest !== undefined && unresolvedWorkerDomains(manifest)) {
    manifest = await reconcileManifest(input, manifest, dependencies);
  }

  let createdCredential: ConnectionCredential | undefined;
  const recoverableCredential = pending === undefined ? existing : credentialFromPending(pending);
  const result = await (dependencies.applyCloudflareSetup ?? applySetup)(
    {
      domain: input.domain,
      ownerEmail: input.ownerEmail,
      ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
      ...(input.adoptExisting === true ? { adoptExisting: true } : {}),
      ...(manifest === undefined ? {} : { deploymentManifest: manifest }),
      ...(recoverableCredential === undefined
        ? {}
        : {
            existingServiceToken: {
              clientId: recoverableCredential.accessClientId,
              clientSecret: recoverableCredential.accessClientSecret,
            },
          }),
      ...(rotation !== undefined && pending === undefined
        ? { serviceTokenRotationPending: true }
        : {}),
      persistence: {
        saveIntent: async (nextManifest) => {
          if (manifest !== undefined && JSON.stringify(manifest) !== JSON.stringify(nextManifest)) {
            throw manifestFailure();
          }
          const createOnly = manifest === undefined;
          await saveDeploymentManifest(nextManifest, dependencies, createOnly);
          manifest = nextManifest;
        },
        saveResource: async (resource, id) => {
          if (manifest === undefined) throw manifestFailure();
          const current = manifest.resources[resource];
          if (current.id !== undefined && current.id !== id) throw manifestFailure();
          manifest = {
            ...manifest,
            resources: { ...manifest.resources, [resource]: { ...current, id } },
          };
          await saveDeploymentManifest(manifest, dependencies);
        },
        beginServiceTokenRotation: async (resourceId) => {
          if (manifest === undefined || manifest.resources.access_service_token.id !== resourceId) {
            throw pendingFailure();
          }
          const nextRotation: ServiceTokenRotationState = {
            version: 1,
            domain: manifest.domain,
            ownerEmail: manifest.ownerEmail,
            accountId: manifest.accountId,
            zoneId: manifest.zoneId,
            resourceId,
          };
          await saveServiceTokenRotation(nextRotation, dependencies);
          rotation = nextRotation;
        },
        saveServiceToken: async (token) => {
          if (manifest === undefined) throw pendingFailure();
          if (rotation !== undefined && rotation.resourceId !== token.resourceId) {
            throw pendingFailure();
          }
          pending = {
            version: 1,
            domain: manifest.domain,
            ownerEmail: manifest.ownerEmail,
            accountId: manifest.accountId,
            zoneId: manifest.zoneId,
            ...token,
          };
          await savePendingServiceToken(pending, dependencies);
          createdCredential = credentialFromPending(pending);
        },
      },
    },
    { env: dependencies.env, fetch: dependencies.fetch },
  );
  const credential =
    createdCredential ?? (pending === undefined ? existing : credentialFromPending(pending));
  if (credential === undefined) {
    throw new SetupRuntimeError(
      "service_token_secret_unavailable",
      "the existing shlook Access service token secret cannot be recovered",
    );
  }

  const encryptionKey = await loadOrCreateDeploymentSecret(dependencies, mayCreateDeploymentSecret);
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
  await deployWithSecretFile(dependencies, configPath, commandEnvironment, encryptionKey);
  if (manifest === undefined) throw manifestFailure();
  manifest = await reconcileManifest(input, manifest, dependencies);
  await verifyDeployment(result, credential, dependencies);

  const connectionPath = await verifiedPersistedConnection(credential, dependencies);
  if (pending !== undefined) await removePendingServiceToken(dependencies);
  if (rotation !== undefined) await removeServiceTokenRotation(dependencies);

  return {
    mode: "apply",
    account: result.account,
    zone: result.zone,
    origins: result.origins,
    resources: result.resources,
    config: { path: configPath },
    deployment: { migrationsApplied: true, deployed: true, secretDeployed: true },
    verification: { ownerHealth: true, privateAccess: true },
    connection: { stored: true, path: connectionPath },
    ...(input.showConnectionToken
      ? { connectionToken: encodeConnectionCredential(credential) }
      : {}),
  };
}
