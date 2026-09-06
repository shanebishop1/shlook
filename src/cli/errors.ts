import { CloudflareSetupError } from "../cli-setup.ts";
import { SetupRuntimeError } from "../cli-setup-runtime.ts";

export class CliError extends Error {
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

export class AuthenticatedRedirectError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("authenticated request was redirected");
    this.status = status;
  }
}

export function normalizeCliError(cause: unknown): CliError {
  if (cause instanceof CliError) return cause;
  if (cause instanceof CloudflareSetupError) {
    return new CliError(cause.code, cause.message, cause.status);
  }
  if (cause instanceof SetupRuntimeError) return new CliError(cause.code, cause.message);
  return new CliError(
    "unexpected_error",
    cause instanceof Error ? cause.message : "unexpected error",
  );
}
