import type { ConnectionCredential } from "../cli-connection.ts";
import type { PublishInput } from "../cli-files.ts";
import type { SetupInput } from "../cli-setup.ts";
import type {
  SetupCommandOptions,
  SetupRuntimeInput,
  SetupRuntimeResult,
} from "../cli-setup-runtime.ts";

export interface ConnectionTokenInput {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  isPaused(): boolean;
  on(event: "data", listener: (chunk: string | Uint8Array) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  pause(): unknown;
  removeListener(event: "data", listener: (chunk: string | Uint8Array) => void): unknown;
  removeListener(event: "end", listener: () => void): unknown;
  removeListener(event: "error", listener: (error: unknown) => void): unknown;
  resume(): unknown;
  setRawMode?(mode: boolean): unknown;
}

export interface ConnectionTokenPrompt {
  write(value: string): unknown;
}

export interface CliOptions {
  json?: boolean;
  plan?: boolean;
  apply?: boolean;
  domain?: string;
  ownerEmail?: string;
  accountId?: string;
  showConnectionToken?: boolean;
  adoptExisting?: boolean;
  entrypoint?: string;
  name?: string;
  description?: string;
  offset?: string;
}

export interface CliDependencies {
  cwd: string;
  packageRoot?: string;
  nodeExecutable?: string;
  wranglerPath?: string;
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  runCommand: (
    command: string,
    args: string[],
    options: SetupCommandOptions,
  ) => Promise<{ code: number }>;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  readSecretInput?: () => Promise<string>;
  currentUid?: () => number | undefined;
  persistConnection?: (credential: ConnectionCredential) => Promise<string>;
  loadConnection?: () => Promise<ConnectionCredential>;
  loadPublishInput?: (path: string, entrypoint?: string) => Promise<PublishInput>;
  parseArguments?: (argv: string[]) => { positionals: string[]; options: CliOptions };
  planSetup?: (input: SetupInput) => Promise<unknown>;
  applySetup?: (input: SetupRuntimeInput) => Promise<SetupRuntimeResult | unknown>;
}

export interface CliCommandResult {
  command: string;
  data: unknown;
  exitCode?: number;
  allowSecrets?: boolean;
}
