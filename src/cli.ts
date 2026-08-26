#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  inspectPackagedSetup,
  loadPublishInput,
  setupPlanData,
  type PublishInput,
  type SetupInspection,
} from "./cli-files.ts";

const DEFAULT_ORIGIN = "https://show.shane-bishop.com";
const PRIVATE_ORIGIN = "https://private.show.shane-bishop.com";
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const assetIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface CliDependencies {
  cwd: string;
  packageRoot?: string;
  nodeExecutable?: string;
  wranglerPath?: string;
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  runCommand: (command: string, args: string[], cwd: string) => Promise<{ code: number }>;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  loadPublishInput?: (path: string, entrypoint?: string) => Promise<PublishInput>;
  parseArguments?: (argv: string[]) => { positionals: string[]; options: CliOptions };
  inspectSetup?: () => Promise<SetupInspection>;
}

interface CliOptions {
  json?: boolean;
  plan?: boolean;
  apply?: boolean;
  entrypoint?: string;
  offset?: string;
}

class CliError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly details?: unknown;
  readonly exitCode: number;

  constructor(code: string, message: string, status?: number, details?: unknown, exitCode = 1) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
    this.exitCode = exitCode;
  }
}

function commandRunner(command: string, args: string[], cwd: string): Promise<{ code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code: code ?? 1 }));
  });
}

function resolvePinnedWrangler(): string {
  const packagePath = createRequire(import.meta.url).resolve("wrangler/package.json");
  return join(dirname(packagePath), "bin", "wrangler.js");
}

function defaults(): CliDependencies {
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
  };
}

function parse(argv: string[]): { positionals: string[]; options: CliOptions } {
  try {
    const { positionals, values } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean" },
        plan: { type: "boolean" },
        apply: { type: "boolean" },
        entrypoint: { type: "string" },
        offset: { type: "string" },
      },
    });
    return { positionals, options: values };
  } catch (cause) {
    throw new CliError("usage_error", cause instanceof Error ? cause.message : "invalid arguments");
  }
}

function requireAssetId(value: string | undefined): string {
  if (value === undefined || !assetIdPattern.test(value))
    throw new CliError("usage_error", "a valid asset ID is required");
  return value;
}

function ownerHeaders(dependencies: CliDependencies, jsonBody = false): Headers {
  const id = dependencies.env.CF_ACCESS_CLIENT_ID;
  const secret = dependencies.env.CF_ACCESS_CLIENT_SECRET;
  if (id === undefined || secret === undefined) {
    throw new CliError(
      "auth_required",
      "CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are required",
    );
  }
  const headers = new Headers({
    "CF-Access-Client-Id": id,
    "CF-Access-Client-Secret": secret,
    "x-shlook-client": "1",
  });
  if (jsonBody) headers.set("content-type", "application/json");
  return headers;
}

function origin(dependencies: CliDependencies): string {
  return (dependencies.env.SHLOOK_API_ORIGIN ?? DEFAULT_ORIGIN).replace(/\/+$/, "");
}

function privateOrigin(dependencies: CliDependencies): string {
  return (dependencies.env.SHLOOK_PRIVATE_ORIGIN ?? PRIVATE_ORIGIN).replace(/\/+$/, "");
}

async function responseData(response: Response): Promise<unknown> {
  if (!response.ok)
    throw new CliError(
      "api_error",
      `API request failed with status ${response.status}`,
      response.status,
    );
  if (response.status === 204) return null;
  const type = response.headers.get("content-type") ?? "";
  return type.includes("application/json") ? response.json() : { status: response.status };
}

async function api(
  dependencies: CliDependencies,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  const response = await dependencies.fetch(`${origin(dependencies)}${path}`, {
    method,
    headers: ownerHeaders(dependencies, body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return responseData(response);
}

function sanitized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitized);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => {
        const normalized = key.replaceAll(/[^a-z]/gi, "").toLowerCase();
        return ![
          "secret",
          "secrethash",
          "token",
          "apitoken",
          "accesstoken",
          "clientsecret",
        ].includes(normalized);
      })
      .map(([key, child]) => [key, sanitized(child)]),
  );
}

async function setupInspection(dependencies: CliDependencies): Promise<SetupInspection> {
  return (
    dependencies.inspectSetup?.() ??
    inspectPackagedSetup(
      dependencies.packageRoot ?? PACKAGE_ROOT,
      dependencies.wranglerPath ?? resolvePinnedWrangler(),
    )
  );
}

async function setupPlan(dependencies: CliDependencies) {
  return setupPlanData(await setupInspection(dependencies));
}

async function setupApply(dependencies: CliDependencies): Promise<never> {
  const inspection = await setupInspection(dependencies);
  if (inspection.conflicts.length > 0) {
    throw new CliError(
      "setup_conflicts",
      "setup apply refused unresolved or conflicting inspection results",
      undefined,
      { status: "blocked", inspection },
      2,
    );
  }
  const packageRoot = dependencies.packageRoot ?? PACKAGE_ROOT;
  const wrangler = dependencies.wranglerPath ?? resolvePinnedWrangler();
  const config = join(packageRoot, "wrangler.jsonc");
  const steps: Array<[string, string[]]> = [
    [
      "d1_migrations",
      [wrangler, "d1", "migrations", "apply", "shlook", "--remote", "--config", config],
    ],
    ["worker_deploy", [wrangler, "deploy", "--config", config]],
  ];
  const completed: string[] = [];
  for (const [name, args] of steps) {
    const result = await dependencies.runCommand(
      dependencies.nodeExecutable ?? process.execPath,
      args,
      packageRoot,
    );
    if (result.code !== 0)
      throw new CliError("command_failed", `${name} failed with exit code ${result.code}`);
    completed.push(name);
  }
  throw new CliError(
    "access_configuration_required",
    "Wrangler steps completed, but Access and host provisioning remain unapplied",
    undefined,
    {
      status: "blocked",
      completed,
      access: {
        status: "not_applied",
        requires: "E5 Access, DNS, and custom-domain provisioning",
      },
    },
    2,
  );
}

function encodedPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function publish(
  dependencies: CliDependencies,
  path: string | undefined,
  entrypoint?: string,
): Promise<unknown> {
  if (path === undefined) throw new CliError("usage_error", "publish requires a file or directory");
  let input: PublishInput;
  try {
    input = await (dependencies.loadPublishInput ?? loadPublishInput)(path, entrypoint);
  } catch (cause) {
    throw new CliError(
      "unsafe_publish_input",
      cause instanceof Error ? cause.message : "invalid publish input",
    );
  }
  const created = (await api(dependencies, "/api/assets", "POST")) as { asset?: { id?: unknown } };
  const id = created.asset?.id;
  if (typeof id !== "string" || !assetIdPattern.test(id))
    throw new CliError("invalid_api_response", "create response did not include an asset ID");

  const files: Array<{ path: string; uploadId: string }> = [];
  let stage = "upload";
  try {
    for (const file of input.files) {
      const response = await dependencies.fetch(
        `${origin(dependencies)}/api/assets/${id}/files/${encodedPath(file.path)}`,
        {
          method: "PUT",
          headers: new Headers([...ownerHeaders(dependencies), ["content-type", file.contentType]]),
          body: file.bytes.buffer.slice(
            file.bytes.byteOffset,
            file.bytes.byteOffset + file.bytes.byteLength,
          ) as ArrayBuffer,
        },
      );
      const uploaded = (await responseData(response)) as { file?: { uploadId?: unknown } };
      if (typeof uploaded.file?.uploadId !== "string")
        throw new CliError("invalid_api_response", "upload response did not include an upload ID");
      files.push({ path: file.path, uploadId: uploaded.file.uploadId });
    }
    stage = "finalize";
    return await api(dependencies, `/api/assets/${id}/finalize`, "POST", {
      entrypoint: input.entrypoint,
      files,
    });
  } catch {
    let cleanupSucceeded = false;
    try {
      await api(dependencies, `/api/assets/${id}`, "DELETE");
      cleanupSucceeded = true;
    } catch {
      // The original publication error remains authoritative.
    }
    throw new CliError("publish_failed", `publication failed during ${stage}`, undefined, {
      assetId: id,
      stage,
      cleanup: { attempted: true, succeeded: cleanupSucceeded },
    });
  }
}

function expiryValue(value: string | undefined): string | null {
  if (value === "none") return null;
  if (value === undefined || Number.isNaN(Date.parse(value)))
    throw new CliError("usage_error", "expiry requires an ISO date or none");
  return value;
}

async function verify(dependencies: CliDependencies, rawId: string | undefined): Promise<unknown> {
  const assetId = requireAssetId(rawId);
  const metadata = (await api(dependencies, `/api/assets/${assetId}`)) as {
    asset?: { state?: unknown };
  };
  if (metadata.asset?.state !== "live")
    throw new CliError("verification_failed", "asset is not live");
  const response = await dependencies.fetch(`${privateOrigin(dependencies)}/assets/${assetId}/`, {
    method: "GET",
    headers: ownerHeaders(dependencies),
  });
  if (!response.ok)
    throw new CliError(
      "verification_failed",
      `artifact returned status ${response.status}`,
      response.status,
    );
  return { assetId, verified: true, status: response.status };
}

async function dispatch(
  positionals: string[],
  options: CliOptions,
  dependencies: CliDependencies,
): Promise<{ command: string; data: unknown; exitCode?: number; allowSecrets?: boolean }> {
  const [command, ...args] = positionals;
  if (command === undefined) throw new CliError("usage_error", "a command is required");
  if (command === "auth" && args[0] === "check")
    return { command: "auth", data: await api(dependencies, "/health") };
  if (command === "setup") {
    if (options.plan === options.apply)
      throw new CliError("usage_error", "setup requires exactly one of --plan or --apply");
    if (options.plan) return { command, data: await setupPlan(dependencies) };
    await setupApply(dependencies);
  }
  if (command === "status") return { command, data: await api(dependencies, "/health") };
  if (command === "publish")
    return { command, data: await publish(dependencies, args[0], options.entrypoint) };
  if (command === "list") {
    const offset =
      options.offset === undefined ? "" : `?offset=${encodeURIComponent(options.offset)}`;
    return { command, data: await api(dependencies, `/api/assets${offset}`) };
  }
  if (command === "show")
    return { command, data: await api(dependencies, `/api/assets/${requireAssetId(args[0])}`) };
  if (command === "visibility") {
    const id = requireAssetId(args[0]);
    if (!["private", "secret_link", "public"].includes(args[1] ?? ""))
      throw new CliError("usage_error", "invalid visibility");
    return {
      command,
      data: await api(dependencies, `/api/assets/${id}/visibility`, "PATCH", {
        visibility: args[1],
      }),
    };
  }
  if (command === "secret") {
    const [operation, rawId] = args;
    const id = requireAssetId(rawId);
    if (!["create", "rotate", "revoke"].includes(operation ?? ""))
      throw new CliError("usage_error", "invalid secret operation");
    const method = operation === "revoke" ? "DELETE" : "POST";
    const query = method === "POST" ? `?mode=${operation}` : "";
    return {
      command,
      data: await api(dependencies, `/api/assets/${id}/secret${query}`, method),
      allowSecrets: method === "POST",
    };
  }
  if ((command === "share" || command === "hard") && args[0] === "expiry") {
    const id = requireAssetId(args[1]);
    const field = command === "share" ? "shareExpiresAt" : "hardExpiresAt";
    return {
      command,
      data: await api(dependencies, `/api/assets/${id}/expiry`, "PATCH", {
        [field]: expiryValue(args[2]),
      }),
    };
  }
  if (command === "delete")
    return {
      command,
      data: await api(dependencies, `/api/assets/${requireAssetId(args[0])}`, "DELETE"),
    };
  if (command === "verify") return { command, data: await verify(dependencies, args[0]) };
  throw new CliError("usage_error", `unknown command: ${command}`);
}

export async function runCli(
  argv: string[],
  dependencies: CliDependencies = defaults(),
): Promise<number> {
  let command = argv.find((value) => !value.startsWith("-")) ?? "unknown";
  let json = argv.includes("--json");
  try {
    const parsed = dependencies.parseArguments?.(argv) ?? parse(argv);
    json = parsed.options.json ?? false;
    command = parsed.positionals[0] ?? "unknown";
    const result = await dispatch(parsed.positionals, parsed.options, dependencies);
    const data = result.allowSecrets ? result.data : sanitized(result.data);
    const output = { ok: true, command: result.command, data };
    dependencies.stdout(`${JSON.stringify(output, null, json ? 0 : 2)}\n`);
    return result.exitCode ?? 0;
  } catch (cause) {
    const error =
      cause instanceof CliError
        ? cause
        : new CliError(
            "unexpected_error",
            cause instanceof Error ? cause.message : "unexpected error",
          );
    const output = {
      ok: false,
      command,
      error: {
        code: error.code,
        message: error.message,
        ...(error.status === undefined ? {} : { status: error.status }),
        ...(error.details === undefined ? {} : { details: sanitized(error.details) }),
      },
    };
    dependencies.stderr(json ? `${JSON.stringify(output)}\n` : `shlook: ${error.message}\n`);
    return error.exitCode;
  }
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2));
