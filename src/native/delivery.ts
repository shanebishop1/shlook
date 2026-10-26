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

export function deliverArtifact(
  response: ServerResponse,
  service: NativeAssetService,
  id: string,
  path: string,
  preview = false,
  head = false,
) {
  try {
    const file = service.readFile(id, path, preview);
    applyArtifactHeaders(response, file.mimeType, file.html);
    response.statusCode = 200;
    response.end(head ? undefined : file.bytes);
  } catch (error) {
    const apiError = error instanceof NativeApiError ? error : new NativeApiError(404, "not_found");
    response.statusCode = apiError.status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.end(JSON.stringify({ error: apiError.code }));
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
