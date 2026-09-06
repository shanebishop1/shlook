import type {
  ApplySetupInput,
  ApplySetupResult,
  CloudflareSetupDependencies,
  SetupDeploymentManifest,
  SetupInput,
  SetupPlan,
} from "../../cli-setup.ts";
import type { ConnectionCredential } from "../../cli-connection.ts";

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

export interface SetupRuntimeFileHandle {
  chmod(mode: number): Promise<void>;
  stat(): Promise<{
    isFile(): boolean;
    mode: number;
    size: number;
    uid: number;
  }>;
  readFile(options: { encoding: "utf8" }): Promise<string>;
  close(): Promise<void>;
}

export interface SetupRuntimeFileSystem {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  realpath(path: string): Promise<string>;
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
