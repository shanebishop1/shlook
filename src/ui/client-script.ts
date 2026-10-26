import { archiveClientScript } from "./client-archive.ts";
import { initClientScript } from "./client-init.ts";
import { sharedClientScript } from "./client-shared.ts";
import { uploadClientScript } from "./client-upload.ts";

export function ownerClientScript(
  options: { requestScript?: string; uploadScript?: string; previewScript?: string } = {},
): string {
  return [
    sharedClientScript(options.requestScript),
    uploadClientScript(options.uploadScript),
    options.previewScript ?? "",
    archiveClientScript(),
    initClientScript(),
  ].join("");
}
