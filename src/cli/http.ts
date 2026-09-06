import { CliError, AuthenticatedRedirectError } from "./errors.ts";
import { origin, origins } from "./origins.ts";
import type { CliDependencies } from "./types.ts";

function ownerHeaders(dependencies: CliDependencies): Headers {
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
  ownerHeaders(dependencies).forEach((value, name) => headers.set(name, value));
  const response = await dependencies.fetch(url, {
    ...init,
    headers,
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    throw new AuthenticatedRedirectError(response.status);
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
