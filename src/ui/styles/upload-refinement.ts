export function uploadRefinementStyles(): string {
  return `
input:not([type="radio"]):focus-visible, textarea:focus-visible {
  outline: 1px solid var(--line-strong); outline-offset: 1px; border-color: var(--muted);
}
.upload-trigger:hover svg { transform: scale(1.12); }
.upload-card:focus, .upload-heading h2:focus { outline: 0; }
.upload-form { position: relative; grid-template-columns: 1fr; }
.upload-close { position: absolute; top: 10px; right: 10px; z-index: 2; }
.drop-zone {
  min-height: 210px; padding: 24px 64px 24px 24px; border: 0;
}
.drop-zone:focus-within { outline: 0; box-shadow: inset 0 0 0 1px var(--line-strong); }
.upload-config[hidden] { display: none; }
.upload-config { padding: 30px; }
.upload-heading { padding-right: 42px; }
.upload-field > span {
  display: inline; color: var(--muted); font-size: 10px; font-weight: 500;
  letter-spacing: 0; text-transform: none;
}
.visibility-choices { align-items: stretch; }
.visibility-option { display: block; height: 100%; }
.visibility-choice {
  height: 100%; min-height: 68px;
  transition: border-color .14s ease, background-color .14s ease, box-shadow .14s ease;
}
.visibility-option input:checked + .visibility-choice { border-color: var(--muted); background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--line-strong); }
.upload-status:empty { display: none; }
html[data-theme="dark"] .drop-zone { background: #1a1c1a; }
html[data-theme="dark"] .drop-zone:hover, html[data-theme="dark"] .drop-zone.is-dragging {
  background: #252825;
}

@media (max-width: 520px) {
  .upload-close { top: 10px; right: 10px; }
  .drop-zone { min-height: 170px; padding: 20px 56px 20px 20px; }
  .upload-config { padding: 22px; }
  .visibility-choice { min-height: 58px; }
}

@media (prefers-reduced-motion: reduce) {
  .upload-trigger:hover svg { transform: none; }
  .visibility-choice { transition: none; }
}`;
}
