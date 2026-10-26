import { CliError, AuthenticatedRedirectError } from "./errors.ts";
import { origin, origins } from "./origins.ts";
import type { CliDependencies } from "./types.ts";

function ownerHeaders(dependencies: CliDependencies): Headers {
  if (dependencies.backend === "native") {
    const name = dependencies.instanceName ?? "default";
    const envName =
      dependencies.profileTokenEnv ?? `SHLOOK_API_TOKEN_${name.replaceAll("-", "_").toUpperCase()}`;
    const token = dependencies.env[envName];
    if (token === undefined)
      throw new CliError(
        "auth_required",
        `authentication required for instance ${name}; set ${envName} or run connect --instance ${name}`,
      );
    if (!/^shlook_api_v1_[A-Za-z0-9_-]{43}$/.test(token))
      throw new CliError("invalid_credential", "configured credential is invalid");
    return new Headers({ Authorization: `Bearer ${token}` });
  }
  const id = dependencies.env.CF_ACCESS_CLIENT_ID;
  const secret = dependencies.env.CF_ACCESS_CLIENT_SECRET;
  if (id === undefined || secret === undefined) {
    throw new CliError(
      "auth_required",
      "CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are required",
    );
  }
  return new Headers({
    "CF-Access-Client-Id": id,
    "CF-Access-Client-Secret": secret,
    "x-shlook-client": "1",
  });
}

export async function authenticatedFetch(
  dependencies: CliDependencies,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new CliError("invalid_configuration", "request URL is invalid");
  }
  if (
    dependencies.backend === "native" &&
    dependencies.selectedOrigin !== undefined &&
    target.origin !== dependencies.selectedOrigin
  ) {
    throw new CliError("invalid_configuration", "request origin is not allowed");
  }
  if (dependencies.backend !== "native" && dependencies.selectedOrigin !== undefined) {
    const allowed = new Set(
      [
        dependencies.selectedOrigin,
        dependencies.env.SHLOOK_PRIVATE_ORIGIN,
        dependencies.env.SHLOOK_PUBLIC_ORIGIN,
        dependencies.env.SHLOOK_SHARE_ORIGIN,
      ]
        .filter((value): value is string => value !== undefined)
        .map((value) => {
          try {
            return new URL(value).origin;
          } catch {
            return "";
          }
        }),
    );
    if (!allowed.has(target.origin))
      throw new CliError("invalid_configuration", "request origin is not allowed");
  }
  ownerHeaders(dependencies).forEach((value, name) => headers.set(name, value));
  const response = await dependencies.fetch(target.href, {
    ...init,
    headers,
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    throw new AuthenticatedRedirectError(response.status, response.headers.get("location"));
  }
  return response;
}

export async function responseData(response: Response): Promise<unknown> {
  if (!response.ok)
    throw new CliError(
      "api_error",
      `API request failed with status ${response.status}`,
      response.status,
    );
  if (response.status === 204) return null;
  const type = response.headers.get("content-type") ?? "";
  return type.includes("application/json") ? response.json() : { status: response.status };
}

export async function api(
  dependencies: CliDependencies,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await authenticatedFetch(dependencies, `${origin(dependencies)}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    if (cause instanceof AuthenticatedRedirectError) {
      throw new CliError(
        "api_error",
        `API request failed with status ${cause.status}`,
        cause.status,
      );
    }
    throw cause;
  }
  return responseData(response);
}

export { origins, origin };
