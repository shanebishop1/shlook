import { constants } from "node:fs";
import { access, open, readdir, realpath, stat } from "node:fs/promises";
import { extname, join, parse as parsePath, relative, resolve, sep } from "node:path";
import type { FileHandle } from "node:fs/promises";

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

export async function inspectPackagedSetup(
  packageRoot: string,
  wranglerPath: string,
): Promise<SetupInspection> {
  const required = ["wrangler.jsonc", "migrations", "src/index.ts"];
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

export function setupPlanData(inspection: SetupInspection) {
  return {
    mode: "plan",
    resources: {
      worker: "shlook",
      d1: "shlook",
      r2: "shlook-assets",
      hosts: ["show.shane-bishop.com", "private.show.shane-bishop.com", "share.shane-bishop.com"],
    },
    access: {
      application: "shlook owner hosts",
      serviceToken: "agent owner API authentication",
      policy: "owner email and service token",
      requires: "narrow Cloudflare API token",
    },
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

function contentType(path: string): string {
  const extension = extname(path).toLowerCase();
  if ([".html", ".htm"].includes(extension)) return "text/html; charset=utf-8";
  if (rasterTypes[extension] !== undefined) return rasterTypes[extension];
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

interface DescriptorPath {
  path: string;
  canonical: string;
}

const openFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

async function descriptorPath(handle: FileHandle): Promise<DescriptorPath> {
  const opened = await handle.stat();
  for (const root of ["/proc/self/fd", "/dev/fd"]) {
    const path = `${root}/${handle.fd}`;
    try {
      const [throughDescriptor, canonical] = await Promise.all([stat(path), realpath(path)]);
      if (
        throughDescriptor.dev === opened.dev &&
        throughDescriptor.ino === opened.ino &&
        resolve(canonical) === canonical
      ) {
        return { path, canonical };
      }
    } catch {
      // Try the other verified descriptor filesystem.
    }
  }
  throw new Error("no verified file-descriptor filesystem is available");
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

async function openInput(path: string): Promise<FileHandle> {
  const absolute = resolve(path);
  const parsed = parsePath(absolute);
  const parts = relative(parsed.root, absolute).split(sep).filter(Boolean);
  let handle = await open(parsed.root, openFlags | constants.O_DIRECTORY);
  try {
    if (!(await handle.stat()).isDirectory()) {
      throw new Error("filesystem root is not a directory");
    }
    let parent = await descriptorPath(handle);
    for (let index = 0; index < parts.length; index += 1) {
      const child = await open(join(parent.path, parts[index]), openFlags);
      try {
        const metadata = await child.stat();
        const descriptor = await descriptorPath(child);
        if (!contained(parent.canonical, descriptor.canonical)) {
          throw new Error("publish input escaped its descriptor parent");
        }
        if (index < parts.length - 1 && !metadata.isDirectory()) {
          throw new Error("publish input ancestor is not a directory");
        }
        await handle.close();
        handle = child;
        parent = descriptor;
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
  directory: FileHandle,
  logicalParent: string,
  files: PublishFile[],
): Promise<void> {
  const metadata = await directory.stat();
  if (!metadata.isDirectory()) throw new Error("publish input contains a non-directory");
  const descriptor = await descriptorPath(directory);
  if (!contained(rootCanonical, descriptor.canonical)) {
    throw new Error("publish input escaped its descriptor root");
  }

  const entries = await readdir(descriptor.path, { withFileTypes: true });
  for (const entry of entries) {
    const publishPath = logicalChild(logicalParent, entry.name);
    const child = await open(join(descriptor.path, entry.name), openFlags);
    try {
      const childMetadata = await child.stat();
      const childDescriptor = await descriptorPath(child);
      if (!contained(rootCanonical, childDescriptor.canonical)) {
        throw new Error("publish input escaped its descriptor root");
      }
      if (childMetadata.isDirectory()) await walk(rootCanonical, child, publishPath, files);
      else if (childMetadata.isFile()) {
        files.push({
          path: publishPath,
          bytes: new Uint8Array(await child.readFile()),
          contentType: contentType(publishPath),
        });
        if (files.length > 500) throw new Error("publish input exceeds 500 files");
      } else throw new Error("publish input contains a non-regular file");
    } finally {
      await child.close();
    }
  }
}

export async function loadPublishInput(
  inputPath: string,
  requestedEntrypoint?: string,
): Promise<PublishInput> {
  const path = resolve(inputPath);
  const handle = await openInput(path);
  try {
    const metadata = await handle.stat();
    const descriptor = await descriptorPath(handle);
    if (metadata.isFile()) {
      const name = parsePath(path).base;
      const extension = extname(name).toLowerCase();
      if (![".html", ".htm", ...Object.keys(rasterTypes)].includes(extension)) {
        throw new Error("single-file publish requires HTML or a raster image");
      }
      if (requestedEntrypoint !== undefined && requestedEntrypoint !== name) {
        throw new Error("single-file entrypoint must equal the filename");
      }
      return {
        entrypoint: name,
        files: [
          {
            path: name,
            bytes: new Uint8Array(await handle.readFile()),
            contentType: contentType(name),
          },
        ],
      };
    }
    if (!metadata.isDirectory())
      throw new Error("publish input must be a regular file or directory");

    const files: PublishFile[] = [];
    await walk(descriptor.canonical, handle, "", files);
    if (files.length === 0) throw new Error("publish directory is empty");
    const entrypoint = requestedEntrypoint ?? "index.html";
    if (!files.some((file) => file.path === entrypoint)) {
      throw new Error(`entrypoint does not exist: ${entrypoint}`);
    }
    return { entrypoint, files };
  } finally {
    await handle.close();
  }
}
