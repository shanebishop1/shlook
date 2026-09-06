export function ledgerStyles(): string {
  return `
.is-open [data-inspect][aria-expanded] svg { transform: rotate(180deg); }
.detail-row { background: var(--faint); }
.detail-row td { height: auto; padding: 0; }
.inspector {
  margin: 0 14px 18px; border: 1px solid var(--line); background: var(--white);
  box-shadow: var(--shadow); display: grid;
  grid-template-columns: minmax(360px, 1.35fr) minmax(390px, 1fr);
}
.large-preview { min-height: 420px; background: #e8ecea; border-right: 1px solid var(--line); overflow: hidden; }
.large-preview .preview-media { min-height: 420px; }
.large-preview .preview-image { object-fit: contain; padding: 22px; }
.large-preview .preview-frame { min-height: 420px; }
.panel { min-width: 0; padding: 26px; }
.panel-head {
  display: flex; align-items: start; justify-content: space-between; gap: 16px;
  padding-bottom: 20px; border-bottom: 1px solid var(--line);
}
.panel h2 { margin: 0; font-size: 18px; letter-spacing: -.025em; }
.panel-head p {
  max-width: 250px; margin: 5px 0 0; overflow: hidden; color: var(--muted);
  font: 11px/1.3 ui-monospace, monospace; text-overflow: ellipsis;
}
.open-link { flex: none; color: var(--accent); font-size: 12px; font-weight: 650; text-decoration: none; }
.open-link:hover { text-decoration: underline; }
.summary { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 16px 0 0; }
.summary div { min-width: 0; }
.summary dt, .control-label, .expiry-grid label {
  color: var(--muted); font-size: 11px; font-weight: 650;
  letter-spacing: .045em; text-transform: uppercase;
}
.summary dd { margin: 5px 0 0; }
.summary .meta-sub { display: inline; margin-left: 5px; }
.control-group { padding: 18px 0; border-bottom: 1px solid var(--line); }
.control-label { display: block; }
.control-label select {
  display: block; width: 100%; height: 36px; margin-top: 9px; padding: 0 9px;
  border: 1px solid var(--line-strong); border-radius: 4px;
  background: var(--white); color: var(--ink); text-transform: capitalize;
}
.hint { margin: 9px 0 0; color: var(--muted); font-size: 11px; }
.button-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.expiry-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 9px; }
.expiry-grid input {
  display: block; width: 100%; min-width: 0; height: 36px; margin-top: 7px;
  padding: 0 9px; border: 1px solid var(--line-strong); border-radius: 4px;
  background: var(--white); color: var(--ink); font-size: 12px;
}
.button { min-height: 36px; padding: 0 12px; border: 1px solid var(--line-strong); border-radius: 4px; background: var(--white); color: #2c3934; font-size: 12px; font-weight: 620; }
.button:hover { border-color: #819089; background: var(--faint); }
.button.primary { border-color: var(--accent); background: var(--accent); color: white; }
.button.primary:hover { background: #104d3d; }
.button.danger { border-color: #d7aaa7; color: var(--danger); }
.button.danger:hover { background: var(--danger-soft); border-color: #c77e79; }
.share-line { display: flex; align-items: center; gap: 8px; margin-top: 9px; }
.share-url {
  flex: 1; min-width: 0; overflow: hidden; color: var(--muted);
  font: 11px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
  text-overflow: ellipsis; white-space: nowrap;
}
.danger-line { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 18px; }
.danger-line span { color: var(--muted); font-size: 11px; }
.confirm { margin-top: 14px; padding: 14px; border: 1px solid #e3b5b1; background: var(--danger-soft); }
.confirm[hidden] { display: none; }
.confirm p { margin: 0; color: #752522; font-size: 12px; }
.card-status { min-height: 18px; margin: 14px 0 0; color: var(--accent); font-size: 12px; }
.card-status.error { color: var(--danger); }
.empty { padding: 58px 24px; text-align: center; color: var(--muted); }
.empty[hidden] { display: none; }
.pagination { display: flex; justify-content: space-between; padding-top: 18px; }
.pagination a { color: var(--accent); font-size: 12px; font-weight: 650; text-decoration: none; }
.pagination a:hover { text-decoration: underline; }

@media (max-width: 1080px) {
  th:nth-child(6), .artifact-row td:nth-child(6) { display: none; }
  .inspector { grid-template-columns: 1fr 1fr; }
}

@media (max-width: 900px) {
  .shell { width: min(100% - 32px, 680px); }
  main { padding-top: 28px; }
  .ledger { overflow: visible; border: 0; background: transparent; }
  table, tbody { display: block; }
  thead { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.artifact-row {
  position: relative; display: grid; grid-template-columns: 128px 1fr 40px;
  grid-template-rows: auto auto; min-height: 104px; margin-top: -1px;
  border: 1px solid var(--line); background: var(--white);
}
  .artifact-row:hover { background: var(--white); }
  .artifact-row.is-open { border-color: var(--line-strong); background: var(--faint); }
  .artifact-row td { display: block; height: auto; padding: 12px; }
  .artifact-row td:nth-child(1) { grid-column: 1; grid-row: 1 / 3; padding-right: 4px; }
  .artifact-row td:nth-child(2) { grid-column: 2; grid-row: 1; padding: 13px 4px 3px 10px; }
  .artifact-row td:nth-child(3) { grid-column: 3; grid-row: 2; padding: 3px 8px 10px 0; }
  .artifact-row td:nth-child(4), .artifact-row td:nth-child(5), .artifact-row td:nth-child(6) { display: none; }
  .artifact-row td:nth-child(7) { grid-column: 3; grid-row: 1; padding: 10px 8px 0 0; }
  .preview-button { width: 112px; height: 78px; }
  .artifact-title { font-size: 14px; }
  .artifact-id { margin-top: 4px; font-size: 10px; }
  .badge { font-size: 0; }
  .badge:before { width: 8px; height: 8px; }
  .inspect-button { width: 32px; height: 32px; }
  .detail-row { display: block; }
  .detail-row[hidden] { display: none; }
  .detail-row td { display: block; padding: 0; }
  .inspector { margin: 0 0 14px; display: block; box-shadow: none; }
  .large-preview { min-height: 250px; border-right: 0; border-bottom: 1px solid var(--line); }
  .large-preview .preview-media, .large-preview .preview-frame { min-height: 250px; }
  .large-preview .preview-image { padding: 14px; }
  .panel { padding: 22px; }
}

@media (max-width: 520px) {
  .shell { width: calc(100% - 24px); }
  .masthead, .masthead .shell { min-height: 60px; }
  .context { display: none; }
  .owner-mark { font-size: 11px; }
  main { padding: 24px 0 50px; }
  .page-heading { align-items: start; margin-bottom: 18px; }
  h1 { font-size: 22px; }
  .page-heading p { max-width: 250px; }
  .count { padding-top: 5px; font-size: 11px; }
  .toolbar { align-items: stretch; gap: 8px; }
  .filter-wrap > span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); }
  .filter-wrap select { min-width: 108px; max-width: 108px; }
  .artifact-row { grid-template-columns: 112px 1fr 38px; min-height: 96px; }
  .preview-button { width: 96px; height: 70px; }
  .artifact-row td:nth-child(1) { padding: 12px 4px 12px 10px; }
  .artifact-row td:nth-child(2) { padding-left: 7px; }
  .panel { padding: 18px; }
  .panel-head { padding-bottom: 16px; }
  .summary, .expiry-grid { grid-template-columns: 1fr; }
  .share-line { align-items: stretch; flex-direction: column; }
  .share-line .button { align-self: flex-start; }
  .danger-line { align-items: start; }
  .button-row { flex-wrap: wrap; }
}`;
}
