import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { handleRequest, type Env } from "./index";

const worker = handleRequest as (
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
) => Promise<Response>;
const access = {
  access: {
    aud: "test-audience",
    getIdentity: async () => ({ email: "owner@example.com" }),
  },
} as unknown as ExecutionContext;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

function request(path: string): Promise<Response> {
  return worker(new Request(`https://owner.example.com${path}`), env, access);
}

describe("worker bootstrap", () => {
  it("reports service health", async () => {
    const response = await request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "shlook" });
  });

  it("rejects unknown routes", async () => {
    expect((await request("/missing")).status).toBe(404);
  });

  it("serves the Folded Signal favicon with a locked-down SVG policy", async () => {
    const response = await request("/favicon.svg");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(body).toContain('aria-label="shlook"');
    expect(body).toContain(
      'd="M22 29 106 11v31L52 54l54 14v31l-84 19V87l54-13-54-14z" fill="#4c9874"',
    );
    expect(body).toContain('d="m52 54 54-12-30 32-54-14z" fill="#d6a36f"');
    expect(body).not.toContain("<script");
  });

  it("renders a protected owner archive without weakening browser policy", async () => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO assets (id, name, description, state, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        id,
        "Forest <release>",
        "A calm & searchable archive entry",
        "live",
        "private",
        now,
        now,
      )
      .run();
    const response = await request("/");
    const body = await response.text();

    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("content-security-policy")).toContain("frame-src 'self'");
    expect(response.headers.get("content-security-policy")).toContain("img-src 'self'");
    expect(body).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg">');
    expect(body).toContain('class="brand-mark"');
    expect(body).toContain('class="brand-ribbon"');
    expect(body).toContain('class="brand-fold"');
    expect(body).not.toContain('<span class="context">');
    expect(body).not.toContain('<span class="owner-mark">');
    expect(body).toContain("M22 29 106 11v31L52 54l54 14v31l-84 19V87l54-13-54-14z");
    expect(body).toContain(".brand-mark { width: 26px; height: 28px; flex: none; }");
    expect(body).toContain(".brand-ribbon { fill: #285e46; }");
    expect(body).toContain(".brand-fold { fill: #b8783d; }");
    expect(body).toContain('html[data-theme="dark"] .brand-ribbon { fill: #4c9874; }');
    expect(body).toContain(id);
    expect(body).toContain("Forest &lt;release&gt;");
    expect(body).toContain("A calm &amp; searchable archive entry");
    expect(body).not.toContain("Forest <release>");
    expect(body).toContain(`https://private.example.com/assets/${id}/`);
    expect(body).toContain('class="ledger"');
    expect(body).toContain('class="preview-frame"');
    expect(body).toContain("data-preview-image");
    expect(body).toContain("data-preview-fallback");
    expect(body).toContain(`src="/preview/assets/${id}/"`);
    expect(body).toContain(`data-preview-fallback data-src="/preview/assets/${id}/"`);
    expect(body).not.toContain("data-preview-fallback src=");
    expect(body).toContain('sandbox="allow-scripts"');
    expect(body).toContain('scrolling="no"');
    expect(body).not.toContain('sandbox="allow-same-origin"');
    expect(body).toContain(
      "if (typeof ResizeObserver === 'function') new ResizeObserver(resize).observe(media);",
    );
    expect(body).toContain("const renderWidth = 1280;");
    expect(body).toContain("if (!frame.hidden) return;");
    expect(body).toContain("requestAnimationFrame(resize)");
    expect(body).toContain("frame.clientWidth !== renderWidth");
    expect(body).toContain("frame.src = frame.dataset.src;");
    expect(body).toContain(
      "filterRecords();\ndocument.querySelectorAll('[data-preview-image]').forEach",
    );
    expect(body).toContain(".preview-media { position: relative; overflow: hidden; }");
    expect(body).toContain("pointer-events: none; transform-origin: top left;");
    expect(body).toContain(".preview-frame { background: #fff; }");
    expect(body).toContain(
      "@keyframes rise-in {\n  from { opacity: 0; transform: translateY(7px); }\n  to { opacity: 1; transform: none; }\n}",
    );
    expect(body).toContain(
      ".ledger { animation: rise-in .3s .08s cubic-bezier(.22, 1, .36, 1) backwards; }",
    );
    expect(body).toContain(".custom-options:not([hidden]) { animation: menu-in .14s");
    expect(body).toContain(".detail-row:not([hidden]) .inspector { animation: detail-in .2s");
    expect(body).toContain(".preview-image { transition: transform .18s");
    expect(body).toContain("@media (prefers-reduced-motion: reduce)");
    expect(body).toContain("const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')");
    expect(body).toContain("behavior: reduceMotion.matches ? 'auto' : 'smooth'");
    expect(body).toContain(".is-open [data-inspect][aria-expanded] svg");
    expect(body).toContain("transform: rotate(180deg);");
    expect(body).not.toContain(".is-open .inspect-button svg{transform:rotate(180deg)}");
    expect(body).toContain("data-inspect");
    expect(body).toContain("data-search");
    expect(body).toContain("data-search-text");
    expect(body).toContain("row.dataset.search = row.dataset.searchText + ' ' + value;");
    expect(body).toContain("data-row-visibility");
    expect(body).not.toMatch(/data-visibility-option="secret_link"[^>]* disabled/);
    expect(body).toContain("data-filter-option");
    expect(body).toContain('aria-haspopup="listbox"');
    expect(body).toContain('class="artifact-link"');
    expect(body).toContain('<span class="artifact-name">Forest &lt;release&gt;</span>');
    expect(body).toContain("html { scrollbar-gutter: stable; }");
    expect(body).toContain(".artifact-link:hover .artifact-name");
    expect(body).toContain("data-theme-toggle");
    expect(body).toContain('data-copy-public aria-label="Copy share link"');
    expect(body).toContain("data-copy-row");
    expect(body).toContain("data-secret-url");
    expect(body).toContain(`data-public-url="https://public.example.com/assets/${id}/"`);
    expect(body).not.toContain(`data-public-url="https://share.example.com/assets/${id}/"`);
    expect(body).toContain("if (typeof body.url === 'string') card.dataset.secretUrl = body.url;");
    expect(body).toContain(
      "const needsSecret = value === 'secret_link' && card.dataset.hasSecret !== '1';",
    );
    expect(body).toContain("const path = needsSecret ? '/secret?mode=create' : '/visibility';");
    expect(body).toContain("if (needsSecret) {");
    expect(body).not.toContain(
      "menu.querySelector('[data-visibility-option=\"secret_link\"]').disabled",
    );
    expect(body).toContain("message.startsWith('Secret URL copied') ? 'Secret link copied.'");
    expect(body).toContain(
      "syncVisibility(id, value);\n    menu.querySelector('[data-menu-button]').disabled = true;",
    );
    expect(body).toContain(
      ".visibility-select .custom-trigger:disabled { cursor: wait; opacity: 1; }",
    );
    expect(body).toContain("Share expiration");
    expect(body).toContain("Artifact expiration");
    expect(body).toContain("Clear expirations");
    expect(body).toContain('data-request-delete aria-label="Delete artifact"');
    expect(body).toContain("data-confirm-for");
    expect(body).toContain('hidden role="dialog" aria-modal="true"');
    expect(body).toContain('class="confirm-card"');
    expect(body).toContain("document.body.classList.add('confirm-open')");
    expect(body).toContain("document.body.appendChild(confirmation)");
    expect(body).toContain("event.target === confirmation");
    expect(body).toContain("@media (min-width: 901px)");
    expect(body).toContain(".large-preview .preview-image { position: absolute; inset: 0; }");
    expect(body).toContain(".large-preview { height: 250px; min-height: 250px; }");
    expect(body).toContain('href="https://github.com/shanebishop1/shlook"');
    expect(body).toContain('aria-label="shlook on GitHub"');
    expect(body).toContain('href="https://owner.example.com/" aria-label="shlook home"');
    expect(body).toContain(".brand { color: inherit; text-decoration: none; }");
    expect(body).toContain("localStorage.getItem('shlook-theme')");
    expect(body).toContain("Shane Bishop");
    expect(body).toContain("2026");
    expect(body).toContain(`data-local-time datetime="${now}"`);
    expect(body).toContain(
      "new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })",
    );
    expect(body).toContain("timeZoneName: 'short'");
    expect(body).toContain("zone.textContent = localTime.format(date);");
    expect(body).toContain("Artifact no longer exists. Refreshing...");
    expect(body).toContain("card.dataset.detail + path");
    expect(body).not.toContain("card.dataset.id+path");
    expect(body).toContain("Artifact archive");
    expect(body).toContain('placeholder="Search name, description, or ID"');
    expect(body).toContain(
      'data-upload-form data-step="file" data-private-origin="https://private.example.com" data-public-origin="https://public.example.com"',
    );
    expect(body).toContain('data-upload-input type="file"');
    expect(body).toContain('name="upload-visibility" value="private" checked');
    expect(body).toContain('name="upload-visibility" value="secret_link"');
    expect(body).toContain("data-upload-submit disabled");
    expect(body).toContain('data-upload-form data-step="file"');
    expect(body).toContain("data-upload-config hidden");
    expect(body).toContain("uploadForm.dataset.step = 'options';");
    expect(body).toContain("dropZone.style.display = 'none';");
    expect(body).toContain("Upload options");
    expect(body).toContain("Title <span>(optional)</span>");
    expect(body).toContain("Description <span>(optional)</span>");
    expect(body).toContain("name: uploadName.value.trim() || uploadName.dataset.fallback");
    expect(body).toContain(">Upload</button>");
    expect(body).not.toContain("Choose one file to begin.");
    expect(body).not.toContain("Private by default");
    expect(body).not.toContain("data-upload-option-summary");
    expect(body).not.toContain("data-upload-hint");
    expect(body).toContain("addEventListener('drop'");
    expect(body).toContain("file.name.replace(/\\.[^.]+$/, '')");
    expect(body).toContain("'/api/assets/' + id + '/files/' + encodeURIComponent(file.name)");
    expect(body).toContain(
      "body: JSON.stringify({ entrypoint: file.name, files: [uploaded.file] })",
    );
    expect(body).toContain("visibility === 'secret_link'");
    expect(body).toContain("await ownerRequest('/api/assets/' + id, { method: 'DELETE' })");
    expect(body).toContain("document.execCommand('copy')");
    expect(body).toContain("data-upload-result");
    expect(body).toContain("data-upload-open");
    expect(body).toContain('class="theme-toggle upload-trigger"');
    expect(body).toContain('data-upload-open aria-label="Upload a file"');
    expect(body).toContain(".upload-trigger:hover svg { transform: scale(1.12); }");
    expect(body).toContain(".visibility-choice {\n  height: 100%;");
    expect(body).toContain(
      'input:not([type="radio"]):focus-visible, textarea:focus-visible {\n  outline: 1px solid var(--line-strong)',
    );
    expect(body).toContain('data-upload-dialog hidden role="dialog" aria-modal="true"');
    expect(body).toContain(".upload-form {\n  width: min(620px, 100%);");
    expect(body).toContain(".drop-zone {\n  min-height: 210px; padding: 24px 64px 24px 24px;");
    expect(body).toContain('html[data-theme="dark"] .drop-zone { background: #1a1c1a; }');
    expect(body).toContain("data-upload-close");
    expect(body).toContain("uploadDialog.hidden = false;");
    expect(body).toContain("uploadDialog.hidden = true;");
    expect(body).toContain("const resetUpload = () => {");
    expect(body).toContain("uploadInput.value = '';");
    expect(body).toContain("uploadForm.dataset.step = 'file';");
    expect(body).toContain("event.stopPropagation()");
    expect(body).toContain('data-select-toggle aria-label="Select artifacts"');
    expect(body).not.toContain("pencilSvg");
    expect(body).toContain("data-select-icon");
    expect(body).toContain("data-upload-progress");
    expect(body).toContain("data-upload-progress-label");
    expect(body).toContain("setUploadProgress");
    expect(body).toContain("uploadForm.dataset.step = 'uploading';");
    expect(body).toContain("uploadForm.dataset.step = 'done';");
    expect(body).toContain("data-upload-again");
    expect(body).toContain(".selection-actions [hidden] { display: none !important; }");
    expect(body).toContain("td.preview-cell { position: relative; }");
    expect(body).toContain('data-batch-delete aria-label="Delete selected artifacts"');
    expect(body).toContain('data-select-item type="checkbox"');
    expect(body).toContain("const setSelectMode = (enabled) => {");
    expect(body).toContain("Promise.all(items.map((item) => ownerRequest('/api/assets/'");
    expect(body).toContain(".upload-result-url { overflow-wrap: anywhere; word-break: break-word;");
    expect(body).not.toContain("<select");
    expect(body).not.toContain("Share expires");
    expect(body).not.toContain("Hard expires");
    expect(body).not.toContain("Clear expiries");
    expect(body).not.toContain(">Copy link</button>");
    expect(body).not.toContain("Latest transmission");
    expect(body).not.toContain("No live artifacts in the ledger.");
    const script = [...body.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].at(-1)?.[1];
    expect(script).toBeDefined();
    expect(() => new Function(script ?? "")).not.toThrow();
  });
});
