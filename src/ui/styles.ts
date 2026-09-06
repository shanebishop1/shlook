import { animationStyles } from "./styles/animations";
import { archiveStyles, detailPreviewStyles } from "./styles/archive";
import { baseStyles } from "./styles/base";
import { controlStyles } from "./styles/controls";
import { ledgerStyles } from "./styles/ledger";
import { darkThemeStyles, themeStyles } from "./styles/theme";
import { uploadDialogStyles } from "./styles/upload-dialog";
import { uploadRefinementStyles } from "./styles/upload-refinement";
import { uploadStyles } from "./styles/upload";

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
