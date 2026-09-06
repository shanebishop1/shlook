export function uploadDialogStyles(): string {
  return `
body.upload-modal-open { overflow: hidden; }
.upload-open { height: 36px; padding: 0 14px; font-weight: 700; }
.upload-card {
  position: fixed; inset: 0; z-index: 100; margin: 0;
  padding: clamp(16px, 4vw, 48px); display: grid; place-items: center;
  background: #0c0f0db8; overflow: auto; overscroll-behavior: contain;
}
.upload-card[hidden] { display: none; }
.upload-form {
  width: min(620px, 100%); max-width: 100%;
  max-height: calc(100vh - 32px); max-height: calc(100dvh - 32px);
  overflow: auto; overscroll-behavior: contain;
  border: 1px solid var(--line-strong); background: var(--white);
  box-shadow: 0 24px 70px #0008;
}
.upload-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.upload-close {
  width: 34px; height: 34px; padding: 0; display: grid;
  place-items: center; flex: none; border: 1px solid var(--line-strong);
  border-radius: 4px; background: var(--white); color: var(--ink);
}
.upload-close:hover { background: var(--faint); }
.upload-close svg { width: 17px; }
.upload-result, .upload-result-copy { min-width: 0; max-width: 100%; }
.upload-result-url { overflow-wrap: anywhere; word-break: break-word; white-space: normal; text-overflow: clip; }
.upload-result-actions { flex-wrap: wrap; }

@media (max-width: 520px) {
  .header-actions { gap: 8px; }
  .upload-open { padding: 0 11px; }
  .upload-card { padding: 10px; place-items: start center; }
  .upload-form { max-height: calc(100vh - 20px); max-height: calc(100dvh - 20px); }
  .upload-result-actions .button { min-width: 0; }
  .upload-result-url { font-size: 10px; }
}

.upload-progress { padding: 36px 30px; display: flex; align-items: center; gap: 18px; }
.upload-progress[hidden] { display: none; }
.upload-progress-copy { min-width: 0; }
.upload-progress h2 { margin: 0; font-size: 18px; letter-spacing: -.025em; }
.upload-progress p { margin: 6px 0 0; color: var(--muted); font-size: 12px; }
.upload-spinner { width: 34px; height: 34px; flex: none; border: 3px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: upload-spin .8s linear infinite; }

@keyframes upload-spin { to { transform: rotate(360deg); } }

@media (prefers-reduced-motion: reduce) {
  .upload-spinner { animation: none; }
}`;
}
