export function controlStyles(): string {
  return `
.header-actions { display: flex; align-items: center; gap: 14px; }
.theme-toggle {
  width: 36px; height: 36px; padding: 0; display: grid; place-items: center;
  border: 1px solid var(--line-strong); border-radius: 4px;
  background: var(--white); color: var(--ink);
}
.theme-toggle:hover { background: var(--faint); }
.theme-toggle svg { width: 17px; }
.theme-toggle .sun { display: none; }
html[data-theme="dark"] .theme-toggle .moon { display: none; }
html[data-theme="dark"] .theme-toggle .sun { display: block; }

.ledger { overflow: visible; }
.artifact-row { cursor: pointer; }
.artifact-row:hover { background: var(--hover); }
.artifact-link { display: block; color: inherit; text-decoration: none; }
.artifact-link:hover .artifact-title, .artifact-link:focus-visible .artifact-title {
  text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 3px;
}
.preview-button, .preview-image, .preview-frame { background: var(--preview); }
.large-preview { background: var(--preview-large); }
.latest { background: var(--accent-soft); }

.custom-select { position: relative; min-width: 0; }
.custom-select:has([aria-expanded="true"]) { z-index: 30; }
.custom-trigger {
  width: 100%; min-height: 34px; padding: 0 9px 0 11px; display: flex;
  align-items: center; justify-content: space-between; gap: 8px;
  border: 1px solid var(--line-strong); border-radius: 4px;
  background: var(--white); color: var(--ink); font-size: 12px;
  font-weight: 600; text-align: left;
}
.custom-trigger:hover, .custom-trigger[aria-expanded="true"] { border-color: var(--accent); background: var(--faint); }
.custom-trigger svg { width: 16px; flex: none; transition: transform .15s; }
.custom-trigger[aria-expanded=true] svg { transform: rotate(180deg); }
.custom-options {
  position: absolute; z-index: 40; top: calc(100% + 5px); right: 0;
  min-width: 100%; padding: 4px; border: 1px solid var(--line-strong);
  border-radius: 5px; background: var(--white); box-shadow: var(--menu-shadow);
}
.custom-options[hidden] { display: none; }
.custom-options button {
  width: 100%; min-height: 34px; padding: 7px 10px; border: 0;
  border-radius: 3px; background: transparent; color: var(--ink);
  font-size: 12px; text-align: left; white-space: nowrap;
}
.custom-options button:hover, .custom-options button:focus-visible { background: var(--faint); }
.custom-options button[aria-selected="true"] { color: var(--accent); font-weight: 700; }
.custom-options button[aria-selected="true"]:after { content: "✓"; float: right; margin-left: 16px; }
.custom-options button:disabled { color: var(--muted); }
.visibility-select { width: 122px; }
.filter-select { width: 145px; }
.filter-wrap .custom-trigger { height: 38px; }
.panel .visibility-select { width: 100%; margin-top: 9px; }
.panel .custom-options { left: 0; right: auto; }
.icon-button { width: 36px; padding: 0; display: grid; place-items: center; flex: none; }
.icon-button svg { width: 17px; }

.toast {
  position: fixed; z-index: 80; left: 50%; bottom: 26px; max-width: calc(100% - 32px);
  padding: 10px 14px; border-radius: 4px; background: #1f2b27; color: #fff;
  font-size: 12px; box-shadow: var(--shadow); opacity: 0; pointer-events: none;
  transform: translate(-50%, 14px); transition: opacity .16s, transform .16s;
}
.toast.show { opacity: 1; transform: translate(-50%, 0); }
.toast.error { background: #772d29; }
.card-status { display: none; }

@media (max-width: 900px) {
  .artifact-row { grid-template-columns: 128px minmax(0, 1fr) 102px; }
  .artifact-row td:nth-child(3) { padding-right: 8px; }
  .visibility-select { width: 94px; }
  .visibility-select .custom-trigger { min-height: 32px; font-size: 11px; }
  .panel .visibility-select { width: 100%; }
}

@media (max-width: 520px) {
  .toolbar { flex-wrap: wrap; }
  .toolbar .search { flex: 1; min-width: 0; }
  .toolbar .selection-actions { order: 3; width: 100%; justify-content: flex-end; }
  .pagination a { min-height: 44px; display: inline-flex; align-items: center; }
  .artifact-row { grid-template-columns: 96px minmax(0, 1fr) 96px; }
  .preview-button { width: 84px; }
  .artifact-title { font-size: 13px; }
  .latest, .owner-mark { display: none; }
  .header-actions { gap: 8px; }
  .toast { bottom: 16px; }
}`;
}
