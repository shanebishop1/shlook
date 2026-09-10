import type { ConnectionCredential } from "../../cli-connection.ts";
import type { ApplySetupResult } from "../../cli-setup.ts";

import type { SetupRuntimeDependencies } from "./dependencies.ts";
import { SetupRuntimeError } from "./errors.ts";

const VERIFY_ATTEMPTS = 6;
const VERIFY_DELAY_MS = 2_000;
const VERIFY_REQUEST_TIMEOUT_MS = 12_000;
const MAX_VERIFICATION_RESPONSE_BYTES = 1_024;

function accessHeaders(credential: ConnectionCredential): Headers {
  return new Headers({
    "CF-Access-Client-Id": credential.accessClientId,
    "CF-Access-Client-Secret": credential.accessClientSecret,
    "x-shlook-client": "1",
  });
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null) {
    const length = Number(rawLength);
    if (Number.isFinite(length) && length > MAX_VERIFICATION_RESPONSE_BYTES) {
      await cancelBody(response);
      throw new Error("verification response is too large");
    }
  }
  if (response.body === null) throw new Error("verification response has no body");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const cancelOnAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancelOnAbort);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_VERIFICATION_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("verification response is too large");
      }
      chunks.push(value);
    }
  } catch (cause) {
    await reader.cancel().catch(() => undefined);
    throw cause;
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function isJsonResponse(response: Response): boolean {
  return (
    (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase() ===
    "application/json"
  );
}

function isExactJson(value: unknown, expected: Record<string, unknown>): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = value as Record<string, unknown>;
  const keys = Object.keys(actual);
  return (
    keys.length === Object.keys(expected).length &&
    keys.every((key) => Object.hasOwn(expected, key) && actual[key] === expected[key])
  );
}

function isAccessDenied(status: number): boolean {
  return status === 302 || status === 401 || status === 403;
}

async function reachesWorker(
  dependencies: SetupRuntimeDependencies,
  url: string,
  expectedStatus: number | ((status: number) => boolean),
  credential: ConnectionCredential | undefined,
  expectedBody?: Record<string, unknown>,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFY_REQUEST_TIMEOUT_MS);
  try {
    const response = await dependencies.fetch(url, {
      method: "GET",
      redirect: "manual",
      ...(credential === undefined ? {} : { headers: accessHeaders(credential) }),
      signal: controller.signal,
    });
    const statusMatches =
      typeof expectedStatus === "function"
        ? expectedStatus(response.status)
        : response.status === expectedStatus;
    if (!statusMatches) {
      await cancelBody(response);
      return false;
    }
    if (expectedBody === undefined) {
      await cancelBody(response);
      return true;
    }
    if (!isJsonResponse(response)) {
      await cancelBody(response);
      return false;
    }
    return isExactJson(await readBoundedJson(response, controller.signal), expectedBody);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
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
    const checks = await Promise.all([
      reachesWorker(dependencies, `${result.origins.owner}/health`, 200, credential, {
        ok: true,
        service: "shlook",
      }),
      reachesWorker(dependencies, `${result.origins.owner}/`, isAccessDenied, undefined),
      reachesWorker(dependencies, `${result.origins.private}/`, 404, credential, {
        error: "not_found",
      }),
      reachesWorker(dependencies, `${result.origins.private}/`, isAccessDenied, undefined),
      reachesWorker(dependencies, `${result.origins.public}/`, 404, undefined, {
        error: "not_found",
      }),
      reachesWorker(dependencies, `${result.origins.share}/`, 404, undefined, {
        error: "not_found",
      }),
    ]);
    if (checks.every(Boolean)) return;
    if (attempt < VERIFY_ATTEMPTS) await sleep(VERIFY_DELAY_MS);
  }
  throw new SetupRuntimeError(
    "setup_verification_failed",
    "deployed shlook access verification failed",
  );
}
