import { createHash, timingSafeEqual } from "node:crypto";

import type { ConnectionCredential } from "../../cli-connection.ts";
import type { PendingServiceToken, SetupDeploymentManifest } from "../../cli-setup.ts";

import { sameCredential } from "./credentials.ts";
import type { SetupRuntimeDependencies } from "./dependencies.ts";
import { pendingCredentialsFailure } from "./errors.ts";
import { setupRuntimeFileSystem } from "./filesystem.ts";
import {
  PENDING_SERVICE_TOKEN_FILE,
  SERVICE_TOKEN_ROTATION_FILE,
  setupStatePath,
} from "./paths.ts";
import { atomicCreateOwnerFile, readOwnerFile, removeOwnerFile } from "./state-files.ts";

export interface PendingServiceTokenState extends PendingServiceToken {
  version: 1;
  domain: string;
  ownerEmail: string;
  accountId: string;
  zoneId: string;
}

export interface ServiceTokenRotationState {
  version: 1;
  domain: string;
  ownerEmail: string;
  accountId: string;
  zoneId: string;
  resourceId: string;
  clientId: string;
  manifestAction: "create" | "adopt";
  priorClientSecretHash?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePending(raw: string): PendingServiceTokenState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw pendingCredentialsFailure();
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
  ) {
    throw pendingCredentialsFailure();
  }
  return value as unknown as PendingServiceTokenState;
}

function parseServiceTokenRotation(raw: string): ServiceTokenRotationState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw pendingCredentialsFailure();
  }
  if (
    !isRecord(value) ||
    ![8, 9].includes(Object.keys(value).length) ||
    Object.keys(value).some(
      (key) =>
        ![
          "version",
          "domain",
          "ownerEmail",
          "accountId",
          "zoneId",
          "resourceId",
          "clientId",
          "manifestAction",
          "priorClientSecretHash",
        ].includes(key),
    ) ||
    value.version !== 1 ||
    !["domain", "ownerEmail", "accountId", "zoneId", "resourceId", "clientId"].every(
      (key) => typeof value[key] === "string" && (value[key] as string).length > 0,
    ) ||
    !["create", "adopt"].includes(String(value.manifestAction)) ||
    (value.priorClientSecretHash === undefined
      ? Object.keys(value).length !== 8
      : Object.keys(value).length !== 9 ||
        typeof value.priorClientSecretHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(value.priorClientSecretHash)) ||
    Object.values(value).some((entry) => typeof entry === "string" && entry.length > 4096)
  ) {
    throw pendingCredentialsFailure();
  }
  return value as unknown as ServiceTokenRotationState;
}

export async function loadPendingServiceToken(
  dependencies: SetupRuntimeDependencies,
): Promise<PendingServiceTokenState | undefined> {
  const raw = await readOwnerFile(
    setupStatePath(dependencies, PENDING_SERVICE_TOKEN_FILE),
    setupRuntimeFileSystem(dependencies),
    pendingCredentialsFailure,
  );
  return raw === undefined ? undefined : parsePending(raw);
}

export async function savePendingServiceToken(
  pending: PendingServiceTokenState,
  dependencies: SetupRuntimeDependencies,
): Promise<void> {
  await atomicCreateOwnerFile(
    setupStatePath(dependencies, PENDING_SERVICE_TOKEN_FILE),
    `${JSON.stringify(pending)}\n`,
    dependencies,
    pendingCredentialsFailure,
  );
}

export async function removePendingServiceToken(
  dependencies: SetupRuntimeDependencies,
): Promise<void> {
  await removeOwnerFile(
    setupStatePath(dependencies, PENDING_SERVICE_TOKEN_FILE),
    dependencies,
    pendingCredentialsFailure,
  );
}

export async function loadServiceTokenRotation(
  dependencies: SetupRuntimeDependencies,
): Promise<ServiceTokenRotationState | undefined> {
  const raw = await readOwnerFile(
    setupStatePath(dependencies, SERVICE_TOKEN_ROTATION_FILE),
    setupRuntimeFileSystem(dependencies),
    pendingCredentialsFailure,
  );
  return raw === undefined ? undefined : parseServiceTokenRotation(raw);
}

export async function saveServiceTokenRotation(
  rotation: ServiceTokenRotationState,
  dependencies: SetupRuntimeDependencies,
): Promise<void> {
  await atomicCreateOwnerFile(
    setupStatePath(dependencies, SERVICE_TOKEN_ROTATION_FILE),
    `${JSON.stringify(rotation)}\n`,
    dependencies,
    pendingCredentialsFailure,
  );
}

export async function removeServiceTokenRotation(
  dependencies: SetupRuntimeDependencies,
): Promise<void> {
  await removeOwnerFile(
    setupStatePath(dependencies, SERVICE_TOKEN_ROTATION_FILE),
    dependencies,
    pendingCredentialsFailure,
  );
}

export function credentialFromPending(pending: PendingServiceTokenState): ConnectionCredential {
  return {
    domain: pending.domain,
    accessClientId: pending.clientId,
    accessClientSecret: pending.clientSecret,
  };
}

export function assertPendingMatchesManifest(
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
    throw pendingCredentialsFailure();
  }
}

export function assertRotationMatchesManifest(
  rotation: ServiceTokenRotationState,
  manifest: SetupDeploymentManifest,
): void {
  const serviceToken = manifest.resources.access_service_token;
  if (
    rotation.domain !== manifest.domain ||
    rotation.ownerEmail !== manifest.ownerEmail ||
    rotation.accountId !== manifest.accountId ||
    rotation.zoneId !== manifest.zoneId ||
    serviceToken.id !== rotation.resourceId ||
    serviceToken.name !== "shlook" ||
    serviceToken.action !== rotation.manifestAction ||
    Object.keys(serviceToken).length !== 3
  ) {
    throw pendingCredentialsFailure();
  }
}

export function credentialSecretHash(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function matchesSecretHash(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(credentialSecretHash(secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

export function assertRotationCredentialTransition(
  rotation: ServiceTokenRotationState,
  pending: PendingServiceTokenState | undefined,
  stored: ConnectionCredential | undefined,
): void {
  const pendingCredential = pending === undefined ? undefined : credentialFromPending(pending);
  if (
    pending !== undefined &&
    (pending.resourceId !== rotation.resourceId || pending.clientId !== rotation.clientId)
  ) {
    throw pendingCredentialsFailure();
  }
  if (
    stored !== undefined &&
    pendingCredential !== undefined &&
    sameCredential(stored, pendingCredential)
  ) {
    return;
  }
  if (
    stored !== undefined &&
    rotation.priorClientSecretHash !== undefined &&
    stored.domain === rotation.domain &&
    stored.accessClientId === rotation.clientId &&
    matchesSecretHash(stored.accessClientSecret, rotation.priorClientSecretHash)
  ) {
    return;
  }
  if (stored === undefined && rotation.priorClientSecretHash === undefined) return;
  throw pendingCredentialsFailure();
}
