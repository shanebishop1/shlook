import { expect, vi } from "vitest";

import {
  CloudflareSetupError,
  type ApplySetupInput,
  type CloudflareSetupDependencies,
} from "../../cli-setup.ts";

export const ACCOUNT_ID = "a".repeat(32);
export const OTHER_ACCOUNT_ID = "c".repeat(32);
export const ZONE_ID = "b".repeat(32);
export const TOKEN = "bootstrap-token-value";

export interface RecordedRequest {
  body?: unknown;
  headers: Headers;
  method: string;
  redirect?: "error" | "follow" | "manual";
  url: URL;
}

export function envelope(result: unknown, init?: ResponseInit): Response {
  return Response.json({ success: true, errors: [], messages: [], result }, init);
}

export function page(result: unknown[], pageNumber = 1, totalPages = 1): Response {
  return Response.json({
    success: true,
    errors: [],
    messages: [],
    result,
    result_info: {
      page: pageNumber,
      per_page: 100,
      total_pages: totalPages,
      count: result.length,
      total_count: result.length,
    },
  });
}

export function contractPage(
  result: unknown[],
  pageNumber: number,
  perPage: number,
  totalCount: number,
): Response {
  return Response.json({
    success: true,
    errors: [],
    messages: [],
    result,
    result_info: {
      page: pageNumber,
      per_page: perPage,
      count: result.length,
      total_count: totalCount,
    },
  });
}

export function baseResponse(url: URL): Response {
  if (url.pathname === "/client/v4/user/tokens/verify") return envelope({ status: "active" });
  if (url.pathname === "/client/v4/memberships") {
    return page([
      {
        id: "membership-id",
        status: "accepted",
        account: { id: ACCOUNT_ID, name: "Primary account" },
      },
    ]);
  }
  if (url.pathname === "/client/v4/zones") {
    return page([
      { id: ZONE_ID, name: "example.com", status: "active", account: { id: ACCOUNT_ID } },
    ]);
  }
  if (url.pathname.endsWith("/d1/database")) return page([]);
  if (url.pathname.endsWith("/r2/buckets")) return envelope({ buckets: [] });
  if (url.pathname.endsWith("/access/apps")) return page([]);
  if (url.pathname.endsWith("/access/service_tokens")) return page([]);
  if (url.pathname.endsWith("/workers/services/shlook")) return new Response(null, { status: 404 });
  if (url.pathname.endsWith("/workers/domains")) return envelope([]);
  throw new Error(`unhandled test request: ${url.pathname}`);
}

export function harness(
  handler: (request: RecordedRequest) => Response | Promise<Response> = ({ url }) =>
    baseResponse(url),
  env: Record<string, string | undefined> = { CLOUDFLARE_API_TOKEN: TOKEN },
): { dependencies: CloudflareSetupDependencies; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request: RecordedRequest = {
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      redirect: init?.redirect,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    requests.push(request);
    return handler(request);
  });
  return { dependencies: { env, fetch }, requests };
}

export const input: ApplySetupInput = {
  domain: "example.com",
  ownerEmail: "owner@example.com",
};

export async function capturedError(operation: Promise<unknown>): Promise<CloudflareSetupError> {
  try {
    await operation;
  } catch (cause) {
    expect(cause).toBeInstanceOf(CloudflareSetupError);
    return cause as CloudflareSetupError;
  }
  throw new Error("expected operation to reject");
}

export function existingStateResponse(url: URL): Response {
  const ownerApp = {
    id: "owner-app-id",
    name: "shlook-owner",
    domain: "shlook.example.com",
    type: "self_hosted",
  };
  const privateApp = {
    id: "private-app-id",
    name: "shlook-private",
    domain: "private.example.com",
    type: "self_hosted",
  };
  if (url.pathname.endsWith("/d1/database")) {
    return page([{ uuid: "database-id", name: "shlook" }]);
  }
  if (url.pathname.endsWith("/r2/buckets")) {
    return envelope({ buckets: [{ name: "shlook-assets" }] });
  }
  if (url.pathname.endsWith("/access/apps")) return page([ownerApp, privateApp]);
  if (url.pathname.endsWith("/access/service_tokens")) {
    return page([
      {
        id: "token-id",
        name: "shlook",
        client_id: "client-id",
        enabled: true,
        expires_at: "2099-01-01T00:00:00.000Z",
      },
    ]);
  }
  if (url.pathname.endsWith("/access/apps/owner-app-id/policies")) {
    return page([
      {
        id: "owner-email-policy-id",
        name: "shlook-owner-email",
        decision: "allow",
        include: [{ email: { email: "owner@example.com" } }],
      },
      {
        id: "owner-token-policy-id",
        name: "shlook-service-token",
        decision: "non_identity",
        include: [{ service_token: { token_id: "token-id" } }],
      },
    ]);
  }
  if (url.pathname.endsWith("/access/apps/private-app-id/policies")) {
    return page([
      {
        id: "private-email-policy-id",
        name: "shlook-owner-email",
        decision: "allow",
        include: [{ email: { email: "owner@example.com" } }],
      },
      {
        id: "private-token-policy-id",
        name: "shlook-service-token",
        decision: "non_identity",
        include: [{ service_token: { token_id: "token-id" } }],
      },
    ]);
  }
  return baseResponse(url);
}
