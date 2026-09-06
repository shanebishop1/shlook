import type { ApplySetupResult, SetupInput } from "../../cli-setup.ts";

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
