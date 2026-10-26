import { animationStyles } from "./styles/animations.ts";
import { archiveStyles, detailPreviewStyles } from "./styles/archive.ts";
import { baseStyles } from "./styles/base.ts";
import { controlStyles } from "./styles/controls.ts";
import { ledgerStyles } from "./styles/ledger.ts";
import { darkThemeStyles, themeStyles } from "./styles/theme.ts";
import { uploadDialogStyles } from "./styles/upload-dialog.ts";
import { uploadRefinementStyles } from "./styles/upload-refinement.ts";
import { uploadStyles } from "./styles/upload.ts";

export function ownerStyles(): string {
  return [
    baseStyles(),
    ledgerStyles(),
    controlStyles(),
    themeStyles(),
    darkThemeStyles(),
    animationStyles(),
    uploadStyles(),
    uploadDialogStyles(),
    uploadRefinementStyles(),
    archiveStyles(),
    detailPreviewStyles(),
  ].join("");
}
