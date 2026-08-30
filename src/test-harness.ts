import { env } from "cloudflare:workers";
import { expect } from "vitest";

import { handleRequest, type Env } from "./index";

export const ownerHost = "owner.example.com";
export const privateHost = "private.example.com";
export const publicHost = "public.example.com";
export const shareHost = "share.example.com";

const worker = handleRequest as (
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
) => Promise<Response>;

export interface AssetJson {
  id: string;
  name: string;
  description: string | null;
  state: "uploading" | "finalizing" | "live";
  visibility: "private";
  createdAt: string;
  updatedAt: string;
}

export interface ManifestFile {
  path: string;
  uploadId: string;
}

export function accessContext(email: string | null = "owner@example.com"): ExecutionContext {
  return {
    access: {
      aud: "test-audience",
      getIdentity: async () => (email === null ? undefined : { email }),
    },
  } as unknown as ExecutionContext;
}

export async function request(
  pathname: string,
  init?: RequestInit,
  host = ownerHost,
  ctx: ExecutionContext | null = accessContext(),
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (
    host === ownerHost &&
    !["GET", "HEAD"].includes(init?.method ?? "GET") &&
    !headers.has("origin")
  ) {
    headers.set("x-shlook-client", "1");
  }
  return worker(
    new Request(`https://${host}${pathname}`, { ...init, headers }),
    env,
    ctx ?? undefined,
  );
}

export async function createAsset(
  name = "Test artifact",
  description: string | null = null,
): Promise<AssetJson> {
  const response = await request("/api/assets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, description }),
  });
  const body = (await response.json()) as { asset: AssetJson };
  return body.asset;
}

export function uploadFile(
  id: string,
  pathname: string,
  body: string,
  contentType = "text/plain",
): Promise<Response> {
  return request(`/api/assets/${id}/files/${pathname}`, {
    method: "PUT",
    headers: { "content-type": contentType },
    body,
  });
}

export async function uploadedFile(response: Response): Promise<ManifestFile> {
  const body = (await response.json()) as { file: ManifestFile };
  return body.file;
}

export function finalizeAsset(
  id: string,
  files: ManifestFile[],
  entrypoint = files[0]?.path,
): Promise<Response> {
  return request(`/api/assets/${id}/finalize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entrypoint, files }),
  });
}

export async function createLiveAsset(
  contents: string,
  name = "Test artifact",
  description: string | null = null,
): Promise<AssetJson> {
  const asset = await createAsset(name, description);
  const upload = await uploadFile(asset.id, "index.html", contents, "text/html");
  expect(upload.status).toBe(201);
  expect((await finalizeAsset(asset.id, [await uploadedFile(upload)])).status).toBe(200);
  return asset;
}
