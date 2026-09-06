import {
  CloudflareSetupError,
  MAX_PAGES,
  MAX_RESPONSE_BYTES,
  PAGE_SIZE,
  type CloudflareSetupDependencies,
} from "./model.ts";
import { isRecord } from "./shared.ts";
import { bootstrapToken } from "./validation.ts";

const API_ORIGIN = "https://api.cloudflare.com";
const API_PREFIX = "/client/v4";

export interface ApiEnvelope {
  success: true;
  result: unknown;
  result_info?: Record<string, unknown>;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null) {
    const length = Number(rawLength);
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new CloudflareSetupError(
        "cloudflare_response_too_large",
        "Cloudflare API response exceeded the allowed size",
      );
    }
  }
  if (response.body === null) {
    throw new CloudflareSetupError(
      "cloudflare_response_invalid",
      "Cloudflare API returned an invalid response",
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new CloudflareSetupError(
          "cloudflare_response_too_large",
          "Cloudflare API response exceeded the allowed size",
        );
      }
      chunks.push(value);
    }
  } catch (cause) {
    if (cause instanceof CloudflareSetupError) throw cause;
    throw new CloudflareSetupError(
      "cloudflare_response_invalid",
      "Cloudflare API returned an invalid response",
    );
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CloudflareSetupError(
      "cloudflare_response_invalid",
      "Cloudflare API returned an invalid response",
    );
  }
}

export class CloudflareApiClient {
  readonly #fetch: typeof fetch;
  readonly #token: string;

  constructor(dependencies: CloudflareSetupDependencies) {
    this.#fetch = dependencies.fetch;
    this.#token = bootstrapToken(dependencies.env);
  }

  async request(path: string, method = "GET", body?: unknown): Promise<ApiEnvelope> {
    let response: Response;
    try {
      response = await this.#fetch(`${API_ORIGIN}${API_PREFIX}${path}`, {
        method,
        redirect: "manual",
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new CloudflareSetupError("cloudflare_request_failed", "Cloudflare API request failed");
    }

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new CloudflareSetupError(
        "cloudflare_redirect_rejected",
        "Cloudflare API redirects are not allowed",
        response.status,
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new CloudflareSetupError(
        "cloudflare_api_error",
        "Cloudflare API request failed",
        response.status,
      );
    }

    const decoded = await readBoundedJson(response);
    if (!isRecord(decoded) || decoded.success !== true || !("result" in decoded)) {
      throw new CloudflareSetupError(
        "cloudflare_response_invalid",
        "Cloudflare API returned an invalid response",
      );
    }
    if (decoded.result_info !== undefined && !isRecord(decoded.result_info)) {
      throw new CloudflareSetupError(
        "cloudflare_response_invalid",
        "Cloudflare API returned an invalid response",
      );
    }
    return decoded as unknown as ApiEnvelope;
  }

  async requestOptional(path: string): Promise<ApiEnvelope | undefined> {
    try {
      return await this.request(path);
    } catch (cause) {
      if (
        cause instanceof CloudflareSetupError &&
        cause.code === "cloudflare_api_error" &&
        cause.status === 404
      ) {
        return undefined;
      }
      throw cause;
    }
  }
}

export function arrayResult(envelope: ApiEnvelope): unknown[] {
  if (!Array.isArray(envelope.result)) {
    throw new CloudflareSetupError(
      "cloudflare_response_invalid",
      "Cloudflare API returned an invalid response",
    );
  }
  return envelope.result;
}

export function objectResult(envelope: ApiEnvelope): Record<string, unknown> {
  if (!isRecord(envelope.result)) {
    throw new CloudflareSetupError(
      "cloudflare_response_invalid",
      "Cloudflare API returned an invalid response",
    );
  }
  return envelope.result;
}

function invalidPagination(): never {
  throw new CloudflareSetupError(
    "cloudflare_pagination_invalid",
    "Cloudflare API returned invalid pagination data",
  );
}

function optionalPageNumber(
  resultInfo: Record<string, unknown>,
  field: string,
  minimum: number,
): number | undefined {
  const value = resultInfo[field];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalidPagination();
  return value as number;
}

function hasNextPage(
  envelope: ApiEnvelope,
  currentPage: number,
  pageItemCount: number,
  accumulatedItemCount: number,
): boolean {
  const resultInfo = envelope.result_info;
  if (resultInfo === undefined) return pageItemCount === PAGE_SIZE;

  const reportedPage = optionalPageNumber(resultInfo, "page", 1);
  const perPage = optionalPageNumber(resultInfo, "per_page", 1);
  const count = optionalPageNumber(resultInfo, "count", 0);
  const totalCount = optionalPageNumber(resultInfo, "total_count", 0);
  const totalPages = optionalPageNumber(resultInfo, "total_pages", 0);
  if (reportedPage !== undefined && reportedPage !== currentPage) invalidPagination();
  if (count !== undefined && count !== pageItemCount) invalidPagination();

  if (totalPages !== undefined) {
    if (
      totalPages > MAX_PAGES ||
      (totalPages === 0 ? currentPage !== 1 || pageItemCount !== 0 : totalPages < currentPage)
    ) {
      invalidPagination();
    }
    return currentPage < totalPages;
  }

  if (totalCount !== undefined) {
    if (accumulatedItemCount > totalCount) invalidPagination();
    if (accumulatedItemCount >= totalCount) return false;
  }

  const effectivePerPage = perPage ?? PAGE_SIZE;
  return pageItemCount >= effectivePerPage;
}

export async function pagedArray(
  client: CloudflareApiClient,
  path: string,
  parameters: Record<string, string>,
  stop?: (items: unknown[]) => boolean,
): Promise<unknown[]> {
  const items: unknown[] = [];
  for (let currentPage = 1; currentPage <= MAX_PAGES; currentPage += 1) {
    const query = new URLSearchParams({
      ...parameters,
      page: String(currentPage),
      per_page: String(PAGE_SIZE),
    });
    const envelope = await client.request(`${path}?${query.toString()}`);
    const pageItems = arrayResult(envelope);
    items.push(...pageItems);
    const morePages = hasNextPage(envelope, currentPage, pageItems.length, items.length);
    if (stop?.(items)) return items;
    if (!morePages) return items;
  }
  throw new CloudflareSetupError(
    "cloudflare_pagination_invalid",
    "Cloudflare API returned invalid pagination data",
  );
}
