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

export function secretStorageFailure(): SetupRuntimeError {
  return new SetupRuntimeError(
    "setup_secret_storage_failed",
    "unable to load or save the deployment encryption secret",
  );
}

export function manifestStorageFailure(): SetupRuntimeError {
  return new SetupRuntimeError(
    "setup_manifest_storage_failed",
    "unable to load or save the deployment ownership manifest",
  );
}

export function pendingCredentialsFailure(): SetupRuntimeError {
  return new SetupRuntimeError(
    "setup_pending_credentials_failed",
    "unable to load or save pending Access credentials",
  );
}
