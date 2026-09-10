import { normalizeAssetMetadata } from "../../asset-metadata.ts";
import { loadPublishInput, type PublishInput } from "../../cli-files.ts";

import { api, authenticatedFetch, responseData } from "../http.ts";
import { CliError } from "../errors.ts";
import { origin, privateOrigin } from "../origins.ts";
import type { CliDependencies } from "../types.ts";

const assetIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function encodedPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function finalizeResult(value: unknown, id: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new CliError(
      "invalid_api_response",
      "finalize response did not include the published asset",
    );
  const asset = (value as { asset?: unknown }).asset;
  if (
    typeof asset !== "object" ||
    asset === null ||
    Array.isArray(asset) ||
    (asset as { id?: unknown }).id !== id
  )
    throw new CliError(
      "invalid_api_response",
      "finalize response did not include the published asset",
    );
  return value as Record<string, unknown>;
}

export async function publish(
  dependencies: CliDependencies,
  path: string | undefined,
  nameValue: string | undefined,
  descriptionValue: string | undefined,
  entrypoint?: string,
): Promise<unknown> {
  if (path === undefined) throw new CliError("usage_error", "publish requires a file or directory");
  const metadata = normalizeAssetMetadata(nameValue, descriptionValue);
  if (metadata === null) {
    throw new CliError(
      "usage_error",
      "publish requires --name with 1-80 characters; --description accepts up to 500 characters",
    );
  }
  let input: PublishInput;
  try {
    input = await (dependencies.loadPublishInput ?? loadPublishInput)(path, entrypoint);
  } catch (cause) {
    throw new CliError(
      "unsafe_publish_input",
      cause instanceof Error ? cause.message : "invalid publish input",
    );
  }
  const created = (await api(dependencies, "/api/assets", "POST", metadata)) as {
    asset?: { id?: unknown };
  };
  const id = created.asset?.id;
  if (typeof id !== "string" || !assetIdPattern.test(id))
    throw new CliError("invalid_api_response", "create response did not include an asset ID");

  const files: Array<{ path: string; uploadId: string }> = [];
  let stage = "upload";
  try {
    for (const file of input.files) {
      const response = await authenticatedFetch(
        dependencies,
        `${origin(dependencies)}/api/assets/${id}/files/${encodedPath(file.path)}`,
        {
          method: "PUT",
          headers: {
            "content-type": file.contentType,
            "content-length": String(file.bytes.byteLength),
          },
          body: file.bytes.buffer.slice(
            file.bytes.byteOffset,
            file.bytes.byteOffset + file.bytes.byteLength,
          ) as ArrayBuffer,
        },
      );
      const uploaded = (await responseData(response)) as { file?: { uploadId?: unknown } };
      if (typeof uploaded.file?.uploadId !== "string")
        throw new CliError("invalid_api_response", "upload response did not include an upload ID");
      files.push({ path: file.path, uploadId: uploaded.file.uploadId });
    }
    stage = "finalize";
    const finalized = finalizeResult(
      await api(dependencies, `/api/assets/${id}/finalize`, "POST", {
        entrypoint: input.entrypoint,
        files,
      }),
      id,
    );
    return {
      ...finalized,
      url: `${privateOrigin(dependencies)}/assets/${id}/`,
    };
  } catch {
    let cleanupSucceeded = false;
    try {
      await api(dependencies, `/api/assets/${id}`, "DELETE");
      cleanupSucceeded = true;
    } catch {
      // The original publication error remains authoritative.
    }
    throw new CliError("publish_failed", `publication failed during ${stage}`, undefined, {
      assetId: id,
      stage,
      cleanup: { attempted: true, succeeded: cleanupSucceeded },
    });
  }
}
