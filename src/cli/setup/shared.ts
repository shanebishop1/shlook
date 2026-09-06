import { CloudflareSetupError, type SetupResourceKey } from "./model.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export function invalidResponse(): never {
  throw new CloudflareSetupError(
    "cloudflare_response_invalid",
    "Cloudflare API returned an invalid response",
  );
}

export function resourceConflict(): never {
  throw new CloudflareSetupError(
    "setup_resource_conflict",
    "an existing Cloudflare resource conflicts with the required shlook setup",
  );
}

export function resourceCollision(): never {
  throw new CloudflareSetupError(
    "setup_resource_collision",
    "an existing fixed-name Cloudflare resource is not owned by this shlook deployment; rerun with --adopt-existing only if intentional",
  );
}

export function manifestMismatch(): never {
  throw new CloudflareSetupError(
    "setup_manifest_mismatch",
    "the persisted shlook deployment manifest does not match Cloudflare or the requested target",
  );
}

export function resourceKey(
  kind:
    | "access_application"
    | "access_email_policy"
    | "access_service_token_policy"
    | "workers_domain",
  surface: "owner" | "private" | "public" | "share",
): SetupResourceKey {
  return `${kind}_${surface}` as SetupResourceKey;
}

export function exactOne<T>(items: T[]): T | undefined {
  if (items.length > 1) resourceConflict();
  return items[0];
}
