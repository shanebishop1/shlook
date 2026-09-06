export function animationStyles(): string {
  return `
html { scrollbar-gutter: stable; }
.identity { align-items: center; }
.brand { display: flex; align-items: center; gap: 8px; }
.brand-mark { width: 26px; height: 28px; flex: none; }
.brand-ribbon { fill: #285e46; }
.brand-fold { fill: #b8783d; }
html[data-theme="dark"] .brand-ribbon { fill: #4c9874; }
html[data-theme="dark"] .brand-fold { fill: #d6a36f; }
.artifact-link:hover .artifact-title, .artifact-link:focus-visible .artifact-title { text-decoration: none; }
.artifact-link:hover .artifact-name, .artifact-link:focus-visible .artifact-name { text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 3px; }
th:nth-child(7) { width: 104px; }
.row-action { gap: 6px; }
.row-copy svg { width: 17px; }
.visibility-select .custom-trigger:disabled { cursor: wait; opacity: 1; }
.preview-media { position: relative; overflow: hidden; }
.preview-frame { position: absolute; inset: 0 auto auto 0; pointer-events: none; transform-origin: top left; }
.preview-frame { background: #fff; }

@keyframes rise-in {
  from { opacity: 0; transform: translateY(7px); }
  to { opacity: 1; transform: none; }
}

@keyframes menu-in {
  from { opacity: 0; transform: translateY(-3px) scale(.985); }
  to { opacity: 1; transform: none; }
}

@keyframes detail-in {
  from { opacity: 0; transform: translateY(-6px); }
  to { opacity: 1; transform: none; }
}

.page-heading { animation: rise-in .26s cubic-bezier(.22, 1, .36, 1) backwards; }
.toolbar { animation: rise-in .26s .04s cubic-bezier(.22, 1, .36, 1) backwards; }
.ledger { animation: rise-in .3s .08s cubic-bezier(.22, 1, .36, 1) backwards; }
.pagination { animation: rise-in .3s .12s cubic-bezier(.22, 1, .36, 1) backwards; }
.custom-options:not([hidden]) { animation: menu-in .14s cubic-bezier(.22, 1, .36, 1) both; transform-origin: top right; }
.panel .custom-options:not([hidden]) { transform-origin: top left; }
.detail-row:not([hidden]) .inspector { animation: detail-in .2s cubic-bezier(.22, 1, .36, 1) both; }
.preview-image { transition: transform .18s cubic-bezier(.22, 1, .36, 1); }
.preview-button:hover .preview-image, .preview-button:focus-visible .preview-image { transform: scale(1.018); }
.theme-toggle, .inspect-button, .button, .custom-trigger { transition: transform .12s ease-out; }
.theme-toggle:active:not(:disabled), .inspect-button:active:not(:disabled), .button:active:not(:disabled), .custom-trigger:active:not(:disabled) { transform: scale(.97); }
.theme-toggle svg { transition: transform .18s cubic-bezier(.22, 1, .36, 1); }
.theme-toggle:hover svg { transform: rotate(-8deg); }
.open-link span { display: inline-block; transition: transform .14s ease-out; }
.open-link:hover span, .open-link:focus-visible span { transform: translate(2px, -2px); }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; scroll-behavior: auto !important; transition: none !important; }
  .preview-button:hover .preview-image, .preview-button:focus-visible .preview-image, .theme-toggle:hover svg, .open-link:hover span, .open-link:focus-visible span { transform: none; }
}`;
}
