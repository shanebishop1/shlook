import { AuthenticatedRedirectError, CliError } from "../errors.ts";
import { api, authenticatedFetch } from "../http.ts";
import { privateOrigin } from "../origins.ts";
import type { CliDependencies } from "../types.ts";
import { decodePath } from "../../worker/artifact-path.ts";

const assetIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function requireAssetId(value: string | undefined): string {
  if (value === undefined || !assetIdPattern.test(value))
    throw new CliError("usage_error", "a valid asset ID is required");
  return value;
}

function expiryValue(value: string | undefined): string | null {
  if (value === "none") return null;
  if (value === undefined || Number.isNaN(Date.parse(value)))
    throw new CliError("usage_error", "expiry requires an ISO date or none");
  return value;
}

function canonicalArtifactRedirect(
  dependencies: CliDependencies,
  assetId: string,
  source: string,
  location: string | null,
): string | null {
  if (location === null) return null;
  let target: URL;
  try {
    target = new URL(location, source);
  } catch {
    return null;
  }
  const privateOriginValue = new URL(privateOrigin(dependencies));
  const prefix = `/assets/${assetId}/`;
  if (
    target.origin !== privateOriginValue.origin ||
    target.username !== "" ||
    target.password !== "" ||
    target.search !== "" ||
    target.hash !== "" ||
    !target.pathname.startsWith(prefix) ||
    target.pathname === prefix ||
    decodePath(target.pathname.slice(prefix.length)) === null
  ) {
    return null;
  }
  return target.href;
}

async function verifyArtifact(dependencies: CliDependencies, assetId: string): Promise<Response> {
  const initialUrl = `${privateOrigin(dependencies)}/assets/${assetId}/`;
  try {
    return await authenticatedFetch(dependencies, initialUrl, { method: "GET" });
  } catch (cause) {
    if (!(cause instanceof AuthenticatedRedirectError)) throw cause;
    if (cause.status !== 302) throw cause;
    const target = canonicalArtifactRedirect(dependencies, assetId, initialUrl, cause.location);
    if (target === null) throw cause;
    // The follow-up remains manual too: one canonical navigation is allowed, not a chain.
    return authenticatedFetch(dependencies, target, { method: "GET" });
  }
}

export async function verify(
  dependencies: CliDependencies,
  rawId: string | undefined,
): Promise<unknown> {
  const assetId = requireAssetId(rawId);
  const metadata = (await api(dependencies, `/api/assets/${assetId}`)) as {
    asset?: { state?: unknown };
  };
  if (metadata.asset?.state !== "live")
    throw new CliError("verification_failed", "asset is not live");
  let response: Response;
  try {
    response = await verifyArtifact(dependencies, assetId);
  } catch (cause) {
    if (cause instanceof AuthenticatedRedirectError) {
      throw new CliError(
        "verification_failed",
        `artifact returned status ${cause.status}`,
        cause.status,
      );
    }
    throw cause;
  }
  if (!response.ok)
    throw new CliError(
      "verification_failed",
      `artifact returned status ${response.status}`,
      response.status,
    );
  return { assetId, verified: true, status: response.status };
}

export async function assetCommand(
  command: string,
  args: string[],
  options: { offset?: string },
  dependencies: CliDependencies,
): Promise<unknown> {
  if (command === "status") return api(dependencies, "/health");
  if (command === "list") {
    const offset =
      options.offset === undefined ? "" : `?offset=${encodeURIComponent(options.offset)}`;
    return api(dependencies, `/api/assets${offset}`);
  }
  if (command === "show") return api(dependencies, `/api/assets/${requireAssetId(args[0])}`);
  if (command === "visibility") {
    const id = requireAssetId(args[0]);
    if (!["private", "secret_link", "public"].includes(args[1] ?? ""))
      throw new CliError("usage_error", "invalid visibility");
    return api(dependencies, `/api/assets/${id}/visibility`, "PATCH", { visibility: args[1] });
  }
  if (command === "secret") {
    const [operation, rawId] = args;
    const id = requireAssetId(rawId);
    if (!["create", "rotate", "revoke"].includes(operation ?? ""))
      throw new CliError("usage_error", "invalid secret operation");
    const method = operation === "revoke" ? "DELETE" : "POST";
    const query = method === "POST" ? `?mode=${operation}` : "";
    return api(dependencies, `/api/assets/${id}/secret${query}`, method);
  }
  if ((command === "share" || command === "hard") && args[0] === "expiry") {
    const id = requireAssetId(args[1]);
    const field = command === "share" ? "shareExpiresAt" : "hardExpiresAt";
    return api(dependencies, `/api/assets/${id}/expiry`, "PATCH", {
      [field]: expiryValue(args[2]),
    });
  }
  if (command === "delete")
    return api(dependencies, `/api/assets/${requireAssetId(args[0])}`, "DELETE");
  if (command === "verify") return verify(dependencies, args[0]);
  throw new CliError("usage_error", `unknown command: ${command}`);
}

export function allowsAssetSecrets(command: string, args: string[]): boolean {
  return command === "secret" && ["create", "rotate"].includes(args[0] ?? "");
}
