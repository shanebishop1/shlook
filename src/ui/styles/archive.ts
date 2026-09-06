export function archiveStyles(): string {
  return `
.brand { color: inherit; text-decoration: none; }
body.confirm-open { overflow: hidden; }
.delete-button { width: 34px; height: 34px; padding: 0; display: grid; place-items: center; }
.delete-button svg { width: 16px; }
.confirm {
  position: fixed; inset: 0; z-index: 120; margin: 0; padding: 20px;
  display: grid; place-items: center; border: 0; background: #0c0f0dc2;
}
.confirm[hidden] { display: none; }
.confirm-card {
  width: min(400px, 100%); padding: 24px;
  border: 1px solid var(--line-strong); border-radius: 5px;
  background: var(--white); box-shadow: 0 24px 70px #0009;
}
.confirm-card > p { margin: 5px 0 0; color: var(--ink); font-size: 16px; font-weight: 700; }
.confirm-card .confirm-copy { margin-top: 8px; color: var(--muted); font-size: 12px; font-weight: 400; }
.confirm-eyebrow { color: var(--danger); font-size: 10px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
.confirm-card .button-row { margin-top: 20px; }
.owner-footer {
  min-height: 72px; display: flex; align-items: center; justify-content: center;
  gap: 9px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11px;
}
.owner-footer a { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 50%; color: var(--muted); }
.owner-footer a:hover, .owner-footer a:focus-visible { color: var(--ink); background: var(--faint); }
.owner-footer svg { width: 16px; }

@media (min-width: 901px) {
  .large-preview { min-height: 0; }
  .large-preview .preview-media { min-height: 0; }
  .large-preview .preview-image { position: absolute; inset: 0; }
}

@media (max-width: 520px) {
  .confirm { padding: 14px; }
  .confirm-card { padding: 20px; }
  .confirm-card .button-row { align-items: stretch; flex-direction: column; }
  .confirm-card .button { width: 100%; }
}`;
}

export function detailPreviewStyles(): string {
  return `
.selection-actions { display: flex; align-items: center; gap: 8px; order: 2; }
.selection-actions .icon-button { width: 34px; height: 34px; padding: 0; display: grid; place-items: center; }
.selection-actions [hidden] { display: none !important; }
.selection-actions svg { width: 16px; }
td.preview-cell { position: relative; }
.select-item {
  position: absolute; top: 19px; left: 20px; z-index: 3; display: none;
  width: 22px; height: 22px; margin: 0; accent-color: var(--accent); cursor: pointer;
  background: var(--white); border-radius: 4px; box-shadow: 0 1px 5px #0007;
}
body.selection-mode .select-item { display: block; }
body.selection-mode .preview-button, body.selection-mode .artifact-link, body.selection-mode .visibility-select, body.selection-mode .row-action {
  pointer-events: none; opacity: .5;
}

@media (min-width: 901px) {
  .large-preview { min-height: 0; }
  .large-preview .preview-media { min-height: 0; }
  .large-preview .preview-image { position: absolute; inset: 0; }
}

@media (max-width: 900px) {
  .selection-actions { order: 0; }
  .large-preview { height: 250px; min-height: 250px; }
  .large-preview .preview-media { height: 250px; min-height: 250px; }
  .large-preview .preview-image { position: absolute; inset: 0; }
}`;
}
