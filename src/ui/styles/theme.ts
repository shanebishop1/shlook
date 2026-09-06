export function themeStyles(): string {
  return `
:root {
  --ink: #202821;
  --muted: #6f7368;
  --faint: #eee9dc;
  --line: #d8d0c0;
  --line-strong: #b8ad99;
  --accent: #285e46;
  --accent-hover: #1f4e3a;
  --on-accent: #fffaf0;
  --owner-dot: #2f7153;
  --danger: #99443a;
  --danger-soft: #fae9e4;
  --paper: #f4f0e6;
  --white: #fbf8f0;
  --hover: #f1ecdf;
  --preview: #e7e1d4;
  --preview-large: #ded7c9;
  --accent-soft: #dfe8dd;
  --menu-shadow: 0 12px 30px #3b31241f;
  --shadow: 0 12px 32px #3b312418;
}

:focus-visible { outline-color: var(--accent); }
.owner-mark:before { background: var(--owner-dot); }
.artifact-row:hover { background: var(--hover); }

.artifact-summary {
  display: -webkit-box;
  margin-top: 5px;
  overflow: hidden;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.35;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 1;
}

.meta { color: var(--ink); opacity: .82; }
.inspect-button, .button { color: var(--ink); }
.button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.button.primary:hover { background: var(--accent-hover); }
.confirm p { color: var(--danger); }

.panel-head .panel-description {
  max-width: 420px;
  margin-top: 8px;
  color: var(--muted);
  font: 12px/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  white-space: normal;
}

.panel-head .panel-id {
  margin-top: 6px;
  color: var(--muted);
  font: 11px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
}

html[data-theme="dark"] .badge.public { color: #e3b583; }
html[data-theme="dark"] .badge.private { color: #c4c8c1; }
html[data-theme="dark"] .badge.secret_link { color: #d9bd94; }
html[data-theme="dark"] .button.primary { color: var(--on-accent); }
html[data-theme="dark"] .button.primary:hover { background: var(--accent-hover); }

@media (max-width: 900px) {
  .artifact-summary { -webkit-line-clamp: 2; }
}`;
}

export function darkThemeStyles(): string {
  return `
html[data-theme="dark"] {
  --ink: #eeede7;
  --muted: #a5aaa2;
  --faint: #20251f;
  --line: #303630;
  --line-strong: #4b534b;
  --accent: #d6a36f;
  --accent-hover: #e3b27e;
  --on-accent: #211a14;
  --owner-dot: #d6a36f;
  --danger: #efa09a;
  --danger-soft: #351f1d;
  --paper: #0c0f0d;
  --white: #141814;
  --hover: #1d221e;
  --preview: #222722;
  --preview-large: #191d1a;
  --accent-soft: #31251d;
  --menu-shadow: 0 18px 42px #000c;
  --shadow: 0 18px 42px #0009;
}`;
}
