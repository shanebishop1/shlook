import { objectResult, pagedArray, type CloudflareApiClient } from "./api.ts";
import {
  CloudflareSetupError,
  type SetupAccount,
  type SetupCapability,
  type SetupZone,
} from "./model.ts";
import { invalidResponse, isRecord, nonemptyString } from "./shared.ts";

interface MembershipRecord {
  status?: unknown;
  account?: { id?: unknown; name?: unknown };
}

interface ZoneRecord {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  account?: { id?: unknown };
}

export async function verifyToken(client: CloudflareApiClient): Promise<void> {
  try {
    const result = objectResult(await client.request("/user/tokens/verify"));
    if (result.status !== "active") {
      throw new CloudflareSetupError(
        "cloudflare_authentication_failed",
        "Cloudflare bootstrap token verification failed",
      );
    }
  } catch (cause) {
    if (
      cause instanceof CloudflareSetupError &&
      cause.code === "cloudflare_api_error" &&
      (cause.status === 401 || cause.status === 403)
    ) {
      throw new CloudflareSetupError(
        "cloudflare_authentication_failed",
        "Cloudflare bootstrap token verification failed",
        cause.status,
      );
    }
    throw cause;
  }
}

export async function resolveAccount(
  client: CloudflareApiClient,
  requestedAccountId?: string,
): Promise<SetupAccount> {
  let memberships: unknown[];
  try {
    memberships = await pagedArray(
      client,
      "/memberships",
      { status: "accepted" },
      requestedAccountId === undefined
        ? undefined
        : (items) =>
            items.some(
              (item) =>
                isRecord(item) &&
                item.status === "accepted" &&
                isRecord(item.account) &&
                item.account.id === requestedAccountId,
            ),
    );
  } catch (cause) {
    throwPermissionError(cause);
  }
  const accepted = memberships.filter((value): value is MembershipRecord => {
    if (
      !isRecord(value) ||
      !["accepted", "pending", "rejected"].includes(String(value.status)) ||
      !isRecord(value.account) ||
      typeof value.account.id !== "string" ||
      !/^[0-9a-f]{32}$/.test(value.account.id) ||
      !nonemptyString(value.account.name)
    ) {
      invalidResponse();
    }
    return value.status === "accepted";
  });
  const selected =
    requestedAccountId === undefined
      ? accepted
      : accepted.filter((membership) => membership.account?.id === requestedAccountId);
  if (selected.length === 0) {
    throw new CloudflareSetupError(
      "account_not_found",
      "no accepted Cloudflare account membership matched setup",
    );
  }
  if (selected.length !== 1) {
    throw new CloudflareSetupError(
      "account_ambiguous",
      "Cloudflare account selection is ambiguous",
    );
  }
  return {
    id: selected[0].account!.id as string,
    name: selected[0].account!.name as string,
  };
}

export async function resolveZone(
  client: CloudflareApiClient,
  accountId: string,
  domain: string,
): Promise<SetupZone> {
  let zones: unknown[];
  try {
    zones = await pagedArray(client, "/zones", {
      name: domain,
      "account.id": accountId,
      status: "active",
    });
  } catch (cause) {
    throwPermissionError(cause);
  }
  for (const value of zones) {
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      !/^[0-9a-f]{32}$/.test(value.id) ||
      !nonemptyString(value.name) ||
      !nonemptyString(value.status) ||
      !isRecord(value.account) ||
      typeof value.account.id !== "string" ||
      !/^[0-9a-f]{32}$/.test(value.account.id)
    ) {
      invalidResponse();
    }
  }
  const exact = zones.filter(
    (value): value is ZoneRecord =>
      isRecord(value) &&
      value.name === domain &&
      value.status === "active" &&
      isRecord(value.account) &&
      value.account.id === accountId &&
      nonemptyString(value.id),
  );
  if (exact.length === 0) {
    throw new CloudflareSetupError(
      "zone_not_found",
      "no exact active Cloudflare zone matched the domain",
    );
  }
  if (exact.length !== 1) {
    throw new CloudflareSetupError("zone_ambiguous", "Cloudflare zone selection is ambiguous");
  }
  return { id: exact[0].id as string, name: domain };
}

function throwPermissionError(cause: unknown): never {
  if (
    cause instanceof CloudflareSetupError &&
    cause.code === "cloudflare_api_error" &&
    (cause.status === 401 || cause.status === 403)
  ) {
    throw new CloudflareSetupError(
      "cloudflare_permission_missing",
      "Cloudflare token lacks a required read permission",
      cause.status,
    );
  }
  throw cause;
}

function capabilityFromError(cause: unknown): SetupCapability | undefined {
  if (!(cause instanceof CloudflareSetupError) || cause.code !== "cloudflare_api_error") {
    return undefined;
  }
  if (cause.status === 401 || cause.status === 403) {
    return { status: "missing_permission", httpStatus: cause.status };
  }
  if (cause.status === 429) return { status: "rate_limited", httpStatus: 429 };
  return {
    status: "unavailable",
    ...(cause.status === undefined ? {} : { httpStatus: cause.status }),
  };
}

export async function probe<T>(
  operation: () => Promise<T>,
): Promise<{ capability: SetupCapability; value?: T }> {
  try {
    return { capability: { status: "available" }, value: await operation() };
  } catch (cause) {
    const capability = capabilityFromError(cause);
    if (capability !== undefined) return { capability };
    throw cause;
  }
}
