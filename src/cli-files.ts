import { access } from "node:fs/promises";
import { extname, join, parse as parsePath, relative, resolve, sep } from "node:path";
import { publishFilesystem } from "./cli-filesystem.ts";
import type { InputHandle } from "./cli-filesystem.ts";
import { maxPublicationBytes, maxUploadBytes, maxUploadFiles } from "./upload-limits.ts";
import { renderSafeMarkdown } from "./markdown.ts";

export interface PublishFile {
  path: string;
  bytes: Uint8Array;
  contentType: string;
}

export interface PublishInput {
  entrypoint: string;
  files: PublishFile[];
}

export interface SetupConflict {
  code: string;
  resource: string;
  message: string;
  unresolved: boolean;
}

export interface SetupInspection {
  inspected: string[];
  conflicts: SetupConflict[];
}

export function sanitizeCliValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeCliValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => {
        const normalized = key.replaceAll(/[^a-z]/gi, "").toLowerCase();
        return ![
          "secret",
          "secrethash",
          "token",
          "apitoken",
          "accesstoken",
          "clientsecret",
        ].includes(normalized);
      })
      .map(([key, child]) => [key, sanitizeCliValue(child)]),
  );
}

export async function inspectPackagedSetup(
  packageRoot: string,
  wranglerPath: string,
): Promise<SetupInspection> {
  const required = [
    "wrangler.jsonc",
    "migrations",
    "src/index.ts",
    "examples/wrangler.custom-domains.jsonc",
    "examples/wrangler.workers-dev.jsonc",
  ];
  const conflicts: SetupConflict[] = [];
  for (const path of required) {
    try {
      await access(join(packageRoot, path));
    } catch {
      conflicts.push({
        code: "package_file_missing",
        resource: path,
        message: `required packaged setup resource is missing: ${path}`,
        unresolved: false,
      });
    }
  }
  try {
    await access(wranglerPath);
  } catch {
    conflicts.push({
      code: "package_file_missing",
      resource: "wrangler",
      message: "the pinned Wrangler runtime dependency is missing",
      unresolved: false,
    });
  }
  conflicts.push({
    code: "remote_state_uninspected",
    resource: "cloudflare",
    message: "remote Worker, D1, R2, host, and Access conflicts require read-only inspection",
    unresolved: true,
  });
  return { inspected: ["package"], conflicts };
}

export function setupPlanData(
  inspection: SetupInspection,
  origins: {
    owner?: string;
    private?: string;
    public?: string;
    share?: string;
  },
) {
  return {
    mode: "plan",
    ready:
      origins.owner !== undefined &&
      origins.private !== undefined &&
      origins.public !== undefined &&
      origins.share !== undefined,
    resources: {
      workers: {
        customDomains: ["one Worker with four custom hostnames"],
        workersDev: ["shlook-owner", "shlook-private", "shlook-public", "shlook-share"],
      },
      bindings: { d1: "DB", r2: "ASSETS", encryptionKey: "SHLOOK_SECRET_ENCRYPTION_KEY" },
      names: "operator_owned",
      origins,
    },
    access: {
      applications: ["owner origin", "private origin"],
      serviceToken: "agent owner API authentication",
      policy: "owner email and service token",
      publicOrigins: "public and share origins remain outside Access",
    },
    automation: "not_applied",
    next: "follow the packaged setup reference and create an operator-owned Wrangler config",
    inspection,
  };
}

const rasterTypes: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const audioTypes: Record<string, string> = {
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".weba": "audio/webm",
};

const videoTypes: Record<string, string> = {
  ".m4v": "video/mp4",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".ogv": "video/ogg",
  ".webm": "video/webm",
};

function contentType(path: string): string {
  const extension = extname(path).toLowerCase();
  if ([".html", ".htm"].includes(extension)) return "text/html; charset=utf-8";
  if (rasterTypes[extension] !== undefined) return rasterTypes[extension];
  if (audioTypes[extension] !== undefined) return audioTypes[extension];
  if (videoTypes[extension] !== undefined) return videoTypes[extension];
  if (extension === ".vtt") return "text/vtt; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".js" || extension === ".mjs") return "text/javascript; charset=utf-8";
  if (extension === ".json") return "application/json";
  if (extension === ".txt") return "text/plain; charset=utf-8";
  if (extension === ".woff") return "font/woff";
  if (extension === ".woff2") return "font/woff2";
  return "application/octet-stream";
}

function contained(root: string, path: string): boolean {
  const value = relative(root, path);
  return (
    value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !value.startsWith(sep))
  );
}

function logicalChild(parent: string, name: string): string {
  if (
    name === "" ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    Array.from(name).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new Error("publish input contains an unsafe path");
  }
  return parent === "" ? name : `${parent}/${name}`;
}

async function openInput(path: string): Promise<InputHandle> {
  const absolute = await publishFilesystem.inputPath(resolve(path));
  const parsed = parsePath(absolute);
  const parts = relative(parsed.root, absolute).split(sep).filter(Boolean);
  let handle: InputHandle = await publishFilesystem.openRoot(parsed.root);
  try {
    if (!(await handle.stat()).isDirectory()) {
      throw new Error("filesystem root is not a directory");
    }
    let parent = await publishFilesystem.canonical(handle);
    for (let index = 0; index < parts.length; index += 1) {
      const child = await publishFilesystem.openChild(handle, parts[index]);
      try {
        const metadata = await child.stat();
        const canonical = await publishFilesystem.canonical(child);
        if (!contained(parent, canonical)) {
          throw new Error("publish input escaped its descriptor parent");
        }
        if (index < parts.length - 1 && !metadata.isDirectory()) {
          throw new Error("publish input ancestor is not a directory");
        }
        await handle.close();
        handle = child;
        parent = canonical;
      } catch (cause) {
        await child.close();
        throw cause;
      }
    }
    return handle;
  } catch (cause) {
    await handle.close();
    throw cause;
  }
}

async function walk(
  rootCanonical: string,
  directory: InputHandle,
  logicalParent: string,
  files: FileCandidate[],
  totalBytes: { value: number },
): Promise<void> {
  const metadata = await directory.stat();
  if (!metadata.isDirectory()) throw new Error("publish input contains a non-directory");
  const canonical = await publishFilesystem.canonical(directory);
  if (!contained(rootCanonical, canonical)) {
    throw new Error("publish input escaped its descriptor root");
  }

  const entries = await publishFilesystem.entries(directory);
  for (const name of entries) {
    const publishPath = logicalChild(logicalParent, name);
    const child = await publishFilesystem.openChild(directory, name);
    let retained = false;
    try {
      const childMetadata = await child.stat();
      const childCanonical = await publishFilesystem.canonical(child);
      if (!contained(rootCanonical, childCanonical)) {
        throw new Error("publish input escaped its descriptor root");
      }
      if (childMetadata.isDirectory())
        await walk(rootCanonical, child, publishPath, files, totalBytes);
      else if (childMetadata.isFile()) {
        if (files.length >= maxUploadFiles) {
          throw new Error(`publish input exceeds ${maxUploadFiles} files`);
        }
        if (!Number.isSafeInteger(childMetadata.size) || childMetadata.size > maxUploadBytes) {
          throw new Error("publish input contains a file larger than 25 MiB");
        }
        if (totalBytes.value + childMetadata.size > maxPublicationBytes) {
          throw new Error("publish input exceeds 100 MiB");
        }
        totalBytes.value += childMetadata.size;
        files.push({
          path: publishPath,
          handle: child,
          size: childMetadata.size,
          contentType: contentType(publishPath),
        });
        retained = true;
      } else throw new Error("publish input contains a non-regular file");
    } finally {
      if (!retained) await child.close();
    }
  }
}

interface FileCandidate {
  path: string;
  handle: InputHandle;
  size: number;
  contentType: string;
}

async function readCandidate(file: FileCandidate): Promise<PublishFile> {
  const bytes = new Uint8Array(file.size);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await file.handle.read(bytes, offset, bytes.byteLength - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  const current = await file.handle.stat();
  if (offset !== file.size || current.size !== file.size) {
    throw new Error("publish input changed while being read");
  }
  return { path: file.path, bytes, contentType: file.contentType };
}

async function closeCandidates(files: FileCandidate[]): Promise<void> {
  await Promise.allSettled(files.map((file) => file.handle.close()));
}

export async function loadPublishInput(
  inputPath: string,
  requestedEntrypoint?: string,
): Promise<PublishInput> {
  const path = resolve(inputPath);
  const handle = await openInput(path);
  try {
    const metadata = await handle.stat();
    const canonical = await publishFilesystem.canonical(handle);
    if (metadata.isFile()) {
      const name = parsePath(path).base;
      const extension = extname(name).toLowerCase();
      if (extension === ".mdx") {
        throw new Error("MDX single-file entrypoints are not supported");
      }
      const media =
        audioTypes[extension] !== undefined
          ? "audio"
          : videoTypes[extension] !== undefined
            ? "video"
            : null;
      if (![".html", ".htm", ".md", ...Object.keys(rasterTypes)].includes(extension) && !media) {
        throw new Error("single-file publish requires HTML, Markdown, a raster image, or media");
      }
      const entrypoint = media ? "index.html" : extension === ".md" ? `${name}.html` : name;
      if (requestedEntrypoint !== undefined && requestedEntrypoint !== entrypoint) {
        throw new Error(
          media
            ? "single-file media entrypoint must be index.html"
            : "single-file entrypoint must equal the filename",
        );
      }
      if (!Number.isSafeInteger(metadata.size) || metadata.size > maxUploadBytes) {
        throw new Error("publish input contains a file larger than 25 MiB");
      }
      const original = await readCandidate({
        path: name,
        handle,
        size: metadata.size,
        contentType: contentType(name),
      });
      if (media) {
        const source = encodeURIComponent(name).replaceAll("'", "%27");
        const label = name.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
        const player =
          media === "audio"
            ? `<p>${label}</p><audio controls preload="metadata" src="${source}"></audio>`
            : `<video controls playsinline preload="metadata" style="max-width:100%" src="${source}"></video>`;
        const page = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${label}</title></head><body>\n${player}\n</body></html>\n`;
        const bytes = new TextEncoder().encode(page);
        if (original.bytes.byteLength + bytes.byteLength > maxPublicationBytes) {
          throw new Error("publish input exceeds 100 MiB");
        }
        return {
          entrypoint,
          files: [original, { path: entrypoint, bytes, contentType: "text/html; charset=utf-8" }],
        };
      }
      if (extension !== ".md") return { entrypoint, files: [original] };
      const source = new TextDecoder("utf-8", { fatal: true }).decode(original.bytes);
      const rendered = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>\n${renderSafeMarkdown(source)}\n</body></html>\n`;
      const bytes = new TextEncoder().encode(rendered);
      if (bytes.byteLength > maxUploadBytes) {
        throw new Error("generated Markdown HTML is larger than 25 MiB");
      }
      return {
        entrypoint,
        files: [{ path: entrypoint, bytes, contentType: "text/html; charset=utf-8" }],
      };
    }
    if (!metadata.isDirectory())
      throw new Error("publish input must be a regular file or directory");

    const candidates: FileCandidate[] = [];
    const totalBytes = { value: 0 };
    try {
      await walk(canonical, handle, "", candidates, totalBytes);
      if (candidates.length === 0) throw new Error("publish directory is empty");
      const entrypoint = requestedEntrypoint ?? "index.html";
      if (!candidates.some((file) => file.path === entrypoint)) {
        throw new Error(`entrypoint does not exist: ${entrypoint}`);
      }
      const files = await Promise.all(candidates.map((file) => readCandidate(file)));
      return { entrypoint, files };
    } finally {
      await closeCandidates(candidates);
    }
  } finally {
    await handle.close();
  }
}
