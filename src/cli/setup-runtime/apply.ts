import type { ConnectionCredential } from "../../cli-connection.ts";
import { encodeConnectionCredential } from "../../cli-connection.ts";
import { applySetup } from "../../cli-setup.ts";

import { sameCredential, storedCredential, verifiedPersistedConnection } from "./credentials.ts";
import type { SetupRuntimeDependencies } from "./dependencies.ts";
import { loadOrCreateDeploymentSecret } from "./deployment-secret.ts";
import { manifestStorageFailure, pendingCredentialsFailure, SetupRuntimeError } from "./errors.ts";
import { loadDeploymentManifest, saveDeploymentManifest } from "./manifest.ts";
import type { SetupRuntimeInput, SetupRuntimeResult } from "./model.ts";
import { reconcileManifest, unresolvedWorkerDomains } from "./reconciliation.ts";
import {
  assertPendingMatchesManifest,
  assertRotationCredentialTransition,
  assertRotationMatchesManifest,
  credentialFromPending,
  credentialSecretHash,
  loadPendingServiceToken,
  loadServiceTokenRotation,
  removePendingServiceToken,
  removeServiceTokenRotation,
  savePendingServiceToken,
  saveServiceTokenRotation,
  type PendingServiceTokenState,
  type ServiceTokenRotationState,
} from "./service-token-journals.ts";
import { verifyDeployment } from "./verification.ts";
import { bootstrapToken, deployWithSecretFile, runWrangler, writeSetupConfig } from "./wrangler.ts";

export async function applySetupRuntime(
  input: SetupRuntimeInput,
  dependencies: SetupRuntimeDependencies,
): Promise<SetupRuntimeResult> {
  const stored = await storedCredential(dependencies);
  const existing = stored?.domain === input.domain ? stored : undefined;
  let manifest = await loadDeploymentManifest(dependencies);
  let pending = await loadPendingServiceToken(dependencies);
  let rotation = await loadServiceTokenRotation(dependencies);
  if (rotation !== undefined) {
    if (manifest === undefined) throw pendingCredentialsFailure();
    assertRotationMatchesManifest(rotation, manifest);
    assertRotationCredentialTransition(rotation, pending, stored);
  }
  const mayCreateDeploymentSecret =
    manifest === undefined ||
    pending !== undefined ||
    rotation !== undefined ||
    manifest.resources.access_service_token.id === undefined;
  if (pending !== undefined) {
    if (manifest === undefined) throw pendingCredentialsFailure();
    assertPendingMatchesManifest(pending, manifest);
    const pendingCredential = credentialFromPending(pending);
    if (
      rotation === undefined &&
      existing !== undefined &&
      !sameCredential(existing, pendingCredential)
    ) {
      throw pendingCredentialsFailure();
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
      ...(rotation !== undefined && pending !== undefined
        ? { serviceTokenRotationCompleted: true }
        : {}),
      persistence: {
        saveIntent: async (nextManifest) => {
          if (manifest !== undefined && JSON.stringify(manifest) !== JSON.stringify(nextManifest)) {
            throw manifestStorageFailure();
          }
          const createOnly = manifest === undefined;
          await saveDeploymentManifest(nextManifest, dependencies, createOnly);
          manifest = nextManifest;
        },
        saveResource: async (resource, id) => {
          if (manifest === undefined) throw manifestStorageFailure();
          const current = manifest.resources[resource];
          if (current.id !== undefined && current.id !== id) throw manifestStorageFailure();
          manifest = {
            ...manifest,
            resources: { ...manifest.resources, [resource]: { ...current, id } },
          };
          await saveDeploymentManifest(manifest, dependencies);
        },
        beginServiceTokenRotation: async (resourceId, clientId) => {
          if (manifest === undefined || manifest.resources.access_service_token.id !== resourceId) {
            throw pendingCredentialsFailure();
          }
          if (
            stored !== undefined &&
            (stored.domain !== manifest.domain || stored.accessClientId !== clientId)
          ) {
            throw pendingCredentialsFailure();
          }
          const nextRotation: ServiceTokenRotationState = {
            version: 1,
            domain: manifest.domain,
            ownerEmail: manifest.ownerEmail,
            accountId: manifest.accountId,
            zoneId: manifest.zoneId,
            resourceId,
            clientId,
            manifestAction: manifest.resources.access_service_token.action,
            ...(stored === undefined
              ? {}
              : { priorClientSecretHash: credentialSecretHash(stored.accessClientSecret) }),
          };
          await saveServiceTokenRotation(nextRotation, dependencies);
          rotation = nextRotation;
        },
        saveServiceToken: async (token) => {
          if (manifest === undefined) throw pendingCredentialsFailure();
          if (
            rotation !== undefined &&
            (rotation.resourceId !== token.resourceId || rotation.clientId !== token.clientId)
          ) {
            throw pendingCredentialsFailure();
          }
          const nextPending: PendingServiceTokenState = {
            version: 1,
            domain: manifest.domain,
            ownerEmail: manifest.ownerEmail,
            accountId: manifest.accountId,
            zoneId: manifest.zoneId,
            ...token,
          };
          pending = nextPending;
          await savePendingServiceToken(nextPending, dependencies);
          createdCredential = credentialFromPending(nextPending);
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
  if (manifest === undefined) throw manifestStorageFailure();
  manifest = await reconcileManifest(input, manifest, dependencies);
  await verifyDeployment(result, credential, dependencies);

  const connectionPath = await verifiedPersistedConnection(credential, dependencies);
  if (rotation !== undefined) await removeServiceTokenRotation(dependencies);
  if (pending !== undefined) await removePendingServiceToken(dependencies);

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
