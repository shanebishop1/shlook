export function uploadStyles(): string {
  return `
.upload-card { margin: 0 0 30px; border: 1px solid var(--line-strong); background: var(--white); box-shadow: 0 8px 24px #3b31240a; }
.upload-form { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(340px, .85fr); }
.drop-zone {
  position: relative; min-height: 220px; padding: 30px; display: flex;
  align-items: center; justify-content: center; gap: 18px;
  border-right: 1px solid var(--line); background: var(--faint);
  text-align: left; cursor: pointer; transition: background-color .14s, border-color .14s;
}
.drop-zone:hover, .drop-zone.is-dragging { background: var(--accent-soft); }
.drop-zone:focus-within { outline: 3px solid var(--accent); outline-offset: -3px; }
.drop-zone input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.upload-glyph {
  width: 46px; height: 46px; display: grid; place-items: center; flex: none;
  border: 1px solid var(--line-strong); border-radius: 50%;
  background: var(--white); color: var(--accent);
}
.upload-glyph svg { width: 23px; }
.drop-copy { min-width: 0; }
.drop-copy strong { display: block; font-size: 17px; letter-spacing: -.02em; }
.drop-copy > span { display: block; margin-top: 5px; color: var(--muted); font-size: 12px; }
.upload-selected { color: var(--ink) !important; }
.upload-config { min-width: 0; padding: 24px; }
.upload-config h2 { margin: 0; font-size: 18px; letter-spacing: -.025em; }
.upload-config > p { margin: 5px 0 18px; color: var(--muted); font-size: 12px; }
.upload-options { border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.upload-options summary { padding: 12px 0; display: flex; align-items: center; justify-content: space-between; gap: 12px; cursor: pointer; font-size: 12px; font-weight: 700; }
.upload-options summary span:last-child { color: var(--muted); font-weight: 500; }
.upload-fields { padding: 2px 0 16px; display: grid; gap: 13px; }
.upload-field { display: grid; gap: 6px; color: var(--muted); font-size: 11px; font-weight: 650; letter-spacing: .045em; text-transform: uppercase; }
.upload-field input, .upload-field textarea {
  width: 100%; border: 1px solid var(--line-strong); border-radius: 4px;
  background: var(--white); color: var(--ink);
  font: 12px/1.4 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  letter-spacing: normal; text-transform: none;
}
.upload-field input { height: 36px; padding: 0 10px; }
.upload-field textarea { min-height: 70px; padding: 9px 10px; resize: vertical; }
.upload-visibility { margin: 0; padding: 0; border: 0; }
.upload-visibility legend {
  margin-bottom: 7px; color: var(--muted); font-size: 11px; font-weight: 650;
  letter-spacing: .045em; text-transform: uppercase;
}
.visibility-choices { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.visibility-option { position: relative; cursor: pointer; }
.visibility-option input { position: absolute; opacity: 0; pointer-events: none; }
.visibility-choice { min-height: 66px; padding: 9px; display: block; border: 1px solid var(--line-strong); border-radius: 4px; background: var(--white); font-size: 11px; }
.visibility-choice strong { display: block; margin-bottom: 3px; color: var(--ink); font-size: 12px; }
.visibility-choice small { color: var(--muted); line-height: 1.3; }
.visibility-option input:checked + .visibility-choice { border-color: var(--accent); background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
.visibility-option input:focus-visible + .visibility-choice { outline: 3px solid var(--accent); outline-offset: 2px; }
.upload-hint { min-height: 34px; margin: 10px 0 0; color: var(--muted); font-size: 11px; }
.upload-actions { margin-top: 16px; display: flex; align-items: center; gap: 12px; }
.upload-status { color: var(--muted); font-size: 11px; }
.upload-status.error { color: var(--danger); }
.upload-result {
  grid-column: 1 / -1; padding: 16px 18px; display: flex; align-items: center;
  justify-content: space-between; gap: 18px; border-top: 1px solid var(--line);
  background: var(--accent-soft);
}
.upload-result[hidden] { display: none; }
.upload-result-copy { min-width: 0; }
.upload-result-label { display: block; color: var(--accent); font-size: 11px; font-weight: 750; letter-spacing: .045em; text-transform: uppercase; }
.upload-result-url {
  display: block; margin-top: 4px; overflow: hidden; color: var(--ink);
  font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  text-overflow: ellipsis; white-space: nowrap;
}
.upload-result-actions { display: flex; gap: 8px; flex: none; }
.upload-result-actions svg { width: 15px; vertical-align: -3px; }

@media (max-width: 900px) {
  .upload-form { grid-template-columns: 1fr; }
  .drop-zone { min-height: 160px; border-right: 0; border-bottom: 1px solid var(--line); }
}

@media (max-width: 520px) {
  .upload-card { margin-bottom: 22px; }
  .drop-zone { min-height: 138px; padding: 22px; justify-content: flex-start; }
  .upload-glyph { width: 40px; height: 40px; }
  .drop-copy strong { font-size: 15px; }
  .upload-config { padding: 19px; }
  .visibility-choices { grid-template-columns: 1fr; }
  .visibility-choice { min-height: 0; }
  .upload-actions { align-items: flex-start; flex-direction: column; }
  .upload-result { align-items: stretch; flex-direction: column; }
  .upload-result-actions { width: 100%; }
  .upload-result-actions .button { flex: 1; }
}`;
}
