import {
  artifactHeaders,
  decodePath,
  previewContentSecurityPolicy,
  readManifest,
  uploadKey,
} from "./artifact";
import { encodePath } from "./artifact-path";
import { deleteAsset } from "./cleanup";
import type { Env } from "./environment";
import { artifactAccess, deploymentConfig } from "./privacy";
import { error } from "./responses";
import type { AssetRow } from "./asset-store";

export async function serveAsset(
  env: Env,
  asset: AssetRow,
  encodedPath: string,
  preview = false,
  cors = false,
  canonicalPrefix?: string,
  search = "",
): Promise<Response> {
  if (asset.state !== "live") return error("not_found", 404);

  if (asset.manifest_id === null) return error("not_found", 404);
  const manifest = await readManifest(env.ASSETS, asset.id, asset.manifest_id);
  if (manifest === null) return error("not_found", 404);

  if (encodedPath === "" && canonicalPrefix !== undefined) {
    const headers = new Headers({
      location: `${canonicalPrefix}/${encodePath(manifest.entrypoint)}${search}`,
      "cache-control": "private, no-store",
      "referrer-policy": "no-referrer",
    });
    if (cors && !preview) headers.set("access-control-allow-origin", "*");
    return new Response(null, { status: 302, headers });
  }

  const path = encodedPath === "" ? manifest.entrypoint : decodePath(encodedPath);
  const file = manifest.files.find((candidate) => candidate.path === path);
  if (path === null || file === undefined) return error("not_found", 404);

  const object = await env.ASSETS.get(uploadKey(asset.id, file.uploadId));
  if (object === null) return error("not_found", 404);

  const headers = artifactHeaders(object);
  if (cors && !preview) headers.set("access-control-allow-origin", "*");
  if (preview) {
    headers.set(
      "content-security-policy",
      previewContentSecurityPolicy(deploymentConfig(env).ownerOrigin, asset.id),
    );
  }
  return new Response(object.body, { headers });
}

export async function serveWithPolicy(
  env: Env,
  asset: AssetRow | null,
  path: string,
  mode: "private" | "public" | "secret",
  secret?: string,
  preview = false,
  canonicalPrefix?: string,
  search = "",
): Promise<Response> {
  if (asset === null || asset.state !== "live") return error("not_found", 404);
  const access = await artifactAccess(asset, mode, secret);
  if (access === "hard_expired") {
    await deleteAsset(env, asset.id);
    return error("not_found", 404);
  }
  return access === "allow"
    ? serveAsset(
        env,
        asset,
        path,
        preview,
        mode === "public" || mode === "secret",
        canonicalPrefix,
        search,
      )
    : error("not_found", 404);
}
