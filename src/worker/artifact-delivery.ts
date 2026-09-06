import { artifactHeaders, decodePath, readManifest, uploadKey } from "./artifact";
import { deleteAsset } from "./cleanup";
import type { Env } from "./environment";
import { error } from "./responses";
import { artifactAccess } from "./privacy";
import type { AssetRow } from "./asset-store";

export async function serveAsset(
  env: Env,
  asset: AssetRow,
  encodedPath: string,
  preview = false,
): Promise<Response> {
  if (asset.state !== "live") return error("not_found", 404);

  if (asset.manifest_id === null) return error("not_found", 404);
  const manifest = await readManifest(env.ASSETS, asset.id, asset.manifest_id);
  if (manifest === null) return error("not_found", 404);

  const path = encodedPath === "" ? manifest.entrypoint : decodePath(encodedPath);
  const file = manifest.files.find((candidate) => candidate.path === path);
  if (path === null || file === undefined) return error("not_found", 404);

  const object = await env.ASSETS.get(uploadKey(asset.id, file.uploadId));
  if (object === null) return error("not_found", 404);

  const headers = artifactHeaders(object);
  if (preview) {
    headers.set(
      "content-security-policy",
      "sandbox allow-scripts; connect-src 'none'; form-action 'none'; " +
        "base-uri 'none'; frame-ancestors 'self'",
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
): Promise<Response> {
  if (asset === null || asset.state !== "live") return error("not_found", 404);
  const access = await artifactAccess(asset, mode, secret);
  if (access === "hard_expired") {
    await deleteAsset(env, asset.id);
    return error("not_found", 404);
  }
  return access === "allow" ? serveAsset(env, asset, path, preview) : error("not_found", 404);
}
