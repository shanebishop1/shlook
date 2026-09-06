import { archiveClientScript } from "./client-archive";
import { initClientScript } from "./client-init";
import { sharedClientScript } from "./client-shared";
import { uploadClientScript } from "./client-upload";

export function ownerClientScript(): string {
  return [
    sharedClientScript(),
    uploadClientScript(),
    archiveClientScript(),
    initClientScript(),
  ].join("");
}
