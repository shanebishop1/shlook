export function baseStyles(): string {
  return `
:root {
  color-scheme: light;
  --ink: #17201d;
  --muted: #65706b;
  --faint: #f4f6f5;
  --line: #d9dfdc;
  --line-strong: #bdc6c2;
  --accent: #165d4a;
  --danger: #9f302f;
  --danger-soft: #fff1f0;
  --paper: #fbfcfb;
  --white: #fff;
  --shadow: 0 12px 32px #1b2b2514;
}
* { box-sizing: border-box; }
html { font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body { margin: 0; background: var(--paper); color: var(--ink); font-size: 14px; line-height: 1.45; -webkit-font-smoothing: antialiased; }
button, input, select { font: inherit; }
button, select { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .48; }
:focus-visible { outline: 3px solid #4e9b85; outline-offset: 2px; }

.shell { width: min(1280px, calc(100% - 48px)); margin: 0 auto; }
.masthead { min-height: 72px; border-bottom: 1px solid var(--line); background: var(--white); }
.masthead .shell { min-height: 72px; display: flex; align-items: center; justify-content: space-between; gap: 24px; }
.identity { display: flex; align-items: baseline; gap: 14px; white-space: nowrap; }
.wordmark { font-weight: 750; font-size: 20px; letter-spacing: -.04em; }
.context { color: var(--muted); font-size: 13px; }
.owner-mark { color: var(--muted); font-size: 12px; display: flex; gap: 8px; align-items: center; }
.owner-mark:before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: #33846d; }
main { padding: 42px 0 70px; }
.page-heading { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin-bottom: 24px; }
h1 { margin: 0; font-size: 26px; line-height: 1.15; letter-spacing: -.035em; font-weight: 690; }
.page-heading p { margin: 6px 0 0; color: var(--muted); font-size: 13px; }
.count { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 13px; }
.toolbar { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 14px; }
.search { position: relative; width: min(380px, 100%); }
.search svg { position: absolute; left: 12px; top: 50%; width: 16px; transform: translateY(-50%); color: var(--muted); pointer-events: none; }
.search input {
  width: 100%; height: 38px; padding: 0 12px 0 38px;
  border: 1px solid var(--line-strong); border-radius: 5px;
  background: var(--white); color: var(--ink);
}
.filter-wrap { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; }
.filter-wrap select {
  height: 38px; min-width: 136px; padding: 0 30px 0 10px;
  border: 1px solid var(--line-strong); border-radius: 5px;
  background: var(--white); color: var(--ink);
}
.ledger { border-top: 1px solid var(--line-strong); border-bottom: 1px solid var(--line-strong); background: var(--white); overflow: hidden; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th {
  height: 40px; padding: 0 14px; text-align: left; color: var(--muted);
  font-size: 11px; font-weight: 650; letter-spacing: .055em;
  text-transform: uppercase; border-bottom: 1px solid var(--line);
}
th:nth-child(1) { width: 190px; }
th:nth-child(2) { width: 22%; }
th:nth-child(3) { width: 125px; }
th:nth-child(4), th:nth-child(5), th:nth-child(6) { width: 155px; }
th:nth-child(7) { width: 66px; }
.artifact-row { border-bottom: 1px solid var(--line); transition: background .14s; }
.artifact-row:hover { background: #fafcfb; }
.artifact-row.is-open { background: var(--faint); border-bottom-color: transparent; }
.artifact-row[hidden], .detail-row[hidden] { display: none; }
td { height: 112px; padding: 13px 14px; vertical-align: middle; }
.preview-button {
  display: block; width: 160px; height: 88px; padding: 0;
  border: 1px solid #cbd2cf; border-radius: 3px; background: #eef1f0;
  overflow: hidden; box-shadow: 0 2px 8px #15231e14;
}
.preview-media { position: relative; width: 100%; height: 100%; min-height: inherit; }
.preview-image, .preview-frame { display: block; width: 100%; height: 100%; border: 0; background: #eef1f0; }
.preview-image { object-fit: cover; }
.preview-frame { pointer-events: none; }
.preview-image[hidden], .preview-frame[hidden] { display: none; }
.artifact-title { display: flex; align-items: center; gap: 8px; color: var(--ink); font-size: 15px; font-weight: 650; letter-spacing: -.01em; }
.latest { padding: 2px 5px; border-radius: 3px; background: #e7f0ed; color: var(--accent); font-size: 9px; letter-spacing: .05em; text-transform: uppercase; }
.artifact-id {
  display: block; max-width: 100%; margin-top: 6px; overflow: hidden;
  color: var(--muted); font: 11px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
  text-overflow: ellipsis;
}
.meta { color: #3e4945; font-size: 13px; font-variant-numeric: tabular-nums; }
.meta-sub { display: block; margin-top: 3px; color: var(--muted); font-size: 11px; }
.badge { display: inline-flex; align-items: center; gap: 6px; color: #315148; font-size: 12px; font-weight: 600; text-transform: capitalize; }
.badge:before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: #39866f; }
.badge.private { color: #5b625f; }
.badge.private:before { background: #8b9591; }
.badge.secret_link { color: #6c5833; }
.badge.secret_link:before { background: #a68243; }
.row-action { display: flex; justify-content: flex-end; }
.inspect-button {
  width: 36px; height: 36px; padding: 0;
  border: 1px solid var(--line-strong); border-radius: 4px;
  background: var(--white); color: #34413c; display: grid; place-items: center;
}
.inspect-button:hover { border-color: #80918a; background: var(--faint); }
.inspect-button svg { width: 17px; transition: transform .16s; }
`;
}
