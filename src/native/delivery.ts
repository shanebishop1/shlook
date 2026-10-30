import type { ServerResponse } from "node:http";
import { NATIVE_BUNDLE_CSP } from "./bundle.ts";
import { NativeApiError, NativeAssetService, mimeTypeForPath } from "./api.ts";

const ACTIVE_OR_UNKNOWN = new Set([
  "application/octet-stream",
  "image/svg+xml",
  "application/xml",
  "text/xml",
  "application/wasm",
]);
export function applyArtifactHeaders(response: ServerResponse, mimeType: string, html = false) {
  const unsupported = ACTIVE_OR_UNKNOWN.has(mimeType) || mimeType === "application/octet-stream";
  response.setHeader(
    "Content-Type",
    unsupported ? "application/octet-stream" : html ? "text/html; charset=utf-8" : mimeType,
  );
  response.setHeader("Content-Security-Policy", NATIVE_BUNDLE_CSP);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  if (unsupported) response.setHeader("Content-Disposition", "attachment");
}

/** Parses a single `bytes=` range; returns null for absent or ignorable headers. */
export function byteRange(header: string | undefined, size: number) {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start: number, end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!suffix) return "unsatisfiable" as const;
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (!Number.isSafeInteger(start) || start >= size || end < start) return "unsatisfiable" as const;
  return { start, end };
}

function deliveryError(response: ServerResponse, error: unknown) {
  const apiError = error instanceof NativeApiError ? error : new NativeApiError(404, "not_found");
  response.statusCode = apiError.status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify({ error: apiError.code }));
}

export function deliverArtifact(
  response: ServerResponse,
  service: NativeAssetService,
  id: string,
  path: string,
  preview = false,
  head = false,
  rangeHeader?: string,
) {
  try {
    const file = service.readFile(id, path, preview);
    applyArtifactHeaders(response, file.mimeType, file.html);
    const size = file.bytes.byteLength;
    // Media elements seek with byte ranges; compiled HTML is always sent whole.
    const range = file.html ? null : byteRange(rangeHeader, size);
    if (!file.html) response.setHeader("Accept-Ranges", "bytes");
    if (range === "unsatisfiable") {
      response.statusCode = 416;
      response.setHeader("Content-Range", `bytes */${size}`);
      response.end();
      return;
    }
    if (range) {
      response.statusCode = 206;
      response.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
      response.setHeader("Content-Length", range.end - range.start + 1);
      response.end(head ? undefined : file.bytes.subarray(range.start, range.end + 1));
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Length", size);
    response.end(head ? undefined : file.bytes);
  } catch (error) {
    deliveryError(response, error);
  }
}

export function deliverDownload(
  response: ServerResponse,
  service: NativeAssetService,
  id: string,
  head = false,
) {
  try {
    const file = service.download(id);
    applyArtifactHeaders(response, "application/octet-stream");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${file.filename.replace(/[^\x20-\x7e]|["\\%]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    );
    response.setHeader("Content-Length", file.bytes.byteLength);
    response.statusCode = 200;
    response.end(head ? undefined : file.bytes);
  } catch (error) {
    deliveryError(response, error);
  }
}

export function entrypointLocation(service: NativeAssetService, id: string) {
  const asset = service.get(id);
  if (!asset.entrypoint) throw new NativeApiError(404, "not_found");
  return `/assets/${encodeURIComponent(id)}/${asset.entrypoint.split("/").map(encodeURIComponent).join("/")}`;
}

export function responseMime(path: string) {
  return mimeTypeForPath(path);
}
