import type { ConnectionCredential } from "../../cli-connection.ts";
import type { ApplySetupResult } from "../../cli-setup.ts";

import type { SetupRuntimeDependencies } from "./dependencies.ts";
import { SetupRuntimeError } from "./errors.ts";

const VERIFY_ATTEMPTS = 6;
const VERIFY_DELAY_MS = 2_000;

function accessHeaders(credential: ConnectionCredential): Headers {
  return new Headers({
    "CF-Access-Client-Id": credential.accessClientId,
    "CF-Access-Client-Secret": credential.accessClientSecret,
    "x-shlook-client": "1",
  });
}

async function reachesWorker(
  dependencies: SetupRuntimeDependencies,
  url: string,
  expectedStatus: number,
  credential: ConnectionCredential,
): Promise<boolean> {
  try {
    const response = await dependencies.fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: accessHeaders(credential),
    });
    const ok = response.status === expectedStatus;
    await response.body?.cancel().catch(() => undefined);
    return ok;
  } catch {
    return false;
  }
}

export async function verifyDeployment(
  result: ApplySetupResult,
  credential: ConnectionCredential,
  dependencies: SetupRuntimeDependencies,
): Promise<void> {
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1) {
    const owner = await reachesWorker(
      dependencies,
      `${result.origins.owner}/health`,
      200,
      credential,
    );
    const privateAccess = await reachesWorker(
      dependencies,
      `${result.origins.private}/`,
      404,
      credential,
    );
    if (owner && privateAccess) return;
    if (attempt < VERIFY_ATTEMPTS) await sleep(VERIFY_DELAY_MS);
  }
  throw new SetupRuntimeError(
    "setup_verification_failed",
    "deployed shlook access verification failed",
  );
}
