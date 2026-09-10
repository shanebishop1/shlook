import { maxUploadFiles } from "../upload-limits";

export const assetIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface Manifest {
  version: 1;
  entrypoint: string;
  files: ManifestFile[];
}

interface ManifestFile {
  path: string;
  uploadId: string;
}

export function decodePath(encodedPath: string): string | null {
  try {
    return safePath(decodeURIComponent(encodedPath));
  } catch {
    return null;
  }
}

function safePath(path: string): string | null {
  if (
    path.length === 0 ||
    path.length > 1024 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    Array.from(path).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    return null;
  }
  const segments = path.split("/");
  return segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ? null
    : path;
}

export function assetPrefix(id: string): string {
  return `assets/${id}/`;
}

export function uploadKey(id: string, uploadId: string): string {
  return `${assetPrefix(id)}uploads/${uploadId}`;
}

export function manifestKey(id: string, manifestId: string): string {
  return `${assetPrefix(id)}manifests/${manifestId}.json`;
}

export function previewContentSecurityPolicy(ownerOrigin: string, id: string): string {
  const previewPrefix = `${ownerOrigin}/preview/${assetPrefix(id)}`;
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src 'unsafe-inline' ${previewPrefix}`,
    `style-src 'unsafe-inline' ${previewPrefix}`,
    `img-src ${previewPrefix} data: blob:`,
    `font-src ${previewPrefix} data:`,
    `media-src ${previewPrefix} blob:`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "worker-src 'none'",
  ].join("; ");
}

export function validateManifest(value: unknown, maxFiles = maxUploadFiles): Manifest | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as { entrypoint?: unknown; files?: unknown };
  if (typeof input.entrypoint !== "string" || !Array.isArray(input.files)) return null;
  if (input.files.length === 0 || input.files.length > maxFiles) return null;

  const entrypoint = safePath(input.entrypoint);
  const files = input.files.map((file): ManifestFile | null => {
    if (typeof file !== "object" || file === null) return null;
    const candidate = file as { path?: unknown; uploadId?: unknown };
    if (typeof candidate.path !== "string" || typeof candidate.uploadId !== "string") return null;
    const path = safePath(candidate.path);
    return path === null || !assetIdPattern.test(candidate.uploadId)
      ? null
      : { path, uploadId: candidate.uploadId };
  });
  if (entrypoint === null || files.some((file) => file === null)) return null;

  const validFiles = files as ManifestFile[];
  if (
    new Set(validFiles.map((file) => file.path)).size !== validFiles.length ||
    new Set(validFiles.map((file) => file.uploadId)).size !== validFiles.length ||
    !validFiles.some((file) => file.path === entrypoint)
  ) {
    return null;
  }
  return { version: 1, entrypoint, files: validFiles };
}

export async function readManifest(
  bucket: R2Bucket,
  id: string,
  manifestId: string,
): Promise<Manifest | null> {
  const object = await bucket.get(manifestKey(id, manifestId));
  if (object === null) return null;
  try {
    return validateManifest(await object.json<unknown>());
  } catch {
    return null;
  }
}

export function artifactHeaders(object: R2Object): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  const mediaType = headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (["text/html", "application/xhtml+xml", "image/svg+xml"].includes(mediaType ?? "")) {
    headers.set(
      "content-security-policy",
      "sandbox allow-scripts allow-modals allow-popups allow-downloads; " +
        "connect-src 'self'; form-action 'none'; base-uri 'none'",
    );
  }
  return headers;
}
