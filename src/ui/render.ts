import { pageSize } from "./data";
import { brandMark, copyIcon, githubIcon, pencilIcon, trashIcon } from "./icons";
import type { OwnerAsset } from "./types";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function dateLabel(value: string | null, empty: string): string {
  if (value === null) return `<span class="meta">${empty}</span>`;
  const date = new Date(value);
  const day = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date);
  return `<time class="meta" data-local-time datetime="${escapeHtml(date.toISOString())}">${escapeHtml(day)}<span class="meta-sub">${escapeHtml(time)} UTC</span></time>`;
}

function previewMedia(previewUrl: string, assetName: string, large = false): string {
  const size = large ? "Large preview" : "Preview";
  const label = escapeHtml(assetName);
  return `<div class="preview-media"${large ? " data-preview-large" : ""}><img class="preview-image" data-preview-image src="${previewUrl}" alt="${size} of ${label}" loading="lazy" referrerpolicy="no-referrer"><iframe class="preview-frame" data-preview-fallback data-src="${previewUrl}" title="${size} of ${label}" sandbox="allow-scripts" scrolling="no" loading="lazy" referrerpolicy="no-referrer" tabindex="-1" hidden></iframe></div>`;
}

function visibilityLabel(value: string): string {
  return value.replace("_", " ").replace(/^./, (character) => character.toUpperCase());
}

function visibilityMenu(asset: OwnerAsset, location: "row" | "panel"): string {
  const options = (["private", "secret_link", "public"] as const)
    .map(
      (visibility) =>
        `<button type="button" role="option" data-visibility-option="${visibility}" aria-selected="${asset.visibility === visibility}">${visibilityLabel(visibility)}</button>`,
    )
    .join("");
  const attribute = location === "row" ? "data-row-visibility" : "data-panel-visibility";
  return `<div class="custom-select visibility-select" ${attribute} data-visibility-menu data-asset-id="${escapeHtml(asset.id)}" data-value="${asset.visibility}"><button class="custom-trigger" type="button" data-menu-button aria-haspopup="listbox" aria-expanded="false"><span data-menu-label>${visibilityLabel(asset.visibility)}</span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button><div class="custom-options" data-menu-list role="listbox" hidden>${options}</div></div>`;
}

function assetRow(
  asset: OwnerAsset,
  latest: boolean,
  privateOrigin: string,
  publicOrigin: string,
): string {
  const id = escapeHtml(asset.id);
  const name = escapeHtml(asset.name);
  const description = asset.description === null ? "" : escapeHtml(asset.description);
  const searchText = escapeHtml(
    `${asset.id} ${asset.name} ${asset.description ?? ""}`.toLowerCase(),
  );
  const privateUrl = `${privateOrigin}/assets/${id}/`;
  const previewUrl = `/preview/assets/${id}/`;
  const publicUrl = `${publicOrigin}/assets/${id}/`;
  const secretUrl = asset.secret_url === null ? "" : escapeHtml(asset.secret_url);
  const shareUrl =
    asset.visibility === "public" ? publicUrl : asset.visibility === "secret_link" ? secretUrl : "";
  const shareLabel =
    shareUrl ||
    (asset.visibility === "secret_link"
      ? "Rotate once to recover this existing secret link"
      : "Available when this artifact is public");
  const rowCopyHidden = asset.visibility === "private" ? " hidden" : "";
  const copyDisabled = shareUrl === "" ? " disabled" : "";
  const secretAction = asset.has_secret === 1 ? "rotate" : "create";
  const created = dateLabel(asset.created_at, "Unknown");
  const updated = dateLabel(asset.updated_at, "Unknown");
  const shareExpiry = dateLabel(asset.share_expires_at, "No expiration");
  const hardExpiry = dateLabel(asset.hard_expires_at, "No expiration");

  return `<tr class="artifact-row" data-record="${id}" data-search-text="${searchText}" data-search="${searchText} ${asset.visibility}" data-visibility="${asset.visibility}" aria-selected="false">
    <td class="preview-cell"><input class="select-item" data-select-item type="checkbox" aria-label="Select artifact"><button class="preview-button" type="button" data-inspect aria-label="Inspect ${name}">${previewMedia(previewUrl, asset.name)}</button></td>
    <td><a class="artifact-link" href="${privateUrl}" target="_blank" rel="noopener noreferrer"><span class="artifact-title"><span class="artifact-name">${name}</span>${latest ? '<span class="latest">Latest</span>' : ""}</span>${description ? `<span class="artifact-summary">${description}</span>` : ""}<span class="artifact-id">${id}</span></a></td>
    <td>${visibilityMenu(asset, "row")}</td>
    <td>${shareExpiry}</td>
    <td>${hardExpiry}</td>
    <td>${updated}</td>
    <td><div class="row-action"><button class="inspect-button row-copy" type="button" data-copy-row aria-label="Copy share link for ${name}"${rowCopyHidden}${copyDisabled}>${copyIcon()}</button><button class="inspect-button" type="button" data-inspect aria-expanded="false" aria-controls="detail-${id}" aria-label="Inspect ${name}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9.5 5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div></td>
  </tr>
  <tr class="detail-row" id="detail-${id}" data-detail="${id}" data-public-url="${publicUrl}" data-secret-url="${secretUrl}" data-has-secret="${asset.has_secret}" hidden>
    <td colspan="7"><div class="inspector">
      <div class="large-preview">${previewMedia(previewUrl, asset.name, true)}</div>
      <div class="panel">
        <div class="panel-head"><div><h2>${name}</h2>${description ? `<p class="panel-description">${description}</p>` : ""}<p class="panel-id">${id}</p></div><a class="open-link" href="${privateUrl}" target="_blank" rel="noopener noreferrer">Open private view <span aria-hidden="true">↗</span></a></div>
        <dl class="summary"><div><dt>Created</dt><dd>${created}</dd></div><div><dt>Updated</dt><dd>${updated}</dd></div></dl>
        <div class="control-group">
          <span class="control-label">Visibility</span>${visibilityMenu(asset, "panel")}
          <p class="hint">Public assets are available to anyone with their share URL. Secret links are capabilities.</p>
          <div class="button-row"><button class="button" type="button" data-secret="${secretAction}">${secretAction === "create" ? "Issue secret link" : "Rotate secret link"}</button><button class="button" type="button" data-secret="revoke"${asset.has_secret === 1 ? "" : " hidden"}>Revoke secret</button></div>
        </div>
        <div class="control-group">
          <span class="control-label">Expiration policy</span>
          <div class="expiry-grid"><label>Share expiration<input data-share-expiry data-iso="${escapeHtml(asset.share_expires_at ?? "")}" type="datetime-local"></label><label>Artifact expiration<input data-hard-expiry data-iso="${escapeHtml(asset.hard_expires_at ?? "")}" type="datetime-local"></label></div>
          <p class="hint">Times are edited locally and stored as UTC. Artifact expiration permanently removes the artifact.</p>
          <div class="button-row"><button class="button primary" type="button" data-expiry>Apply policy</button><button class="button" type="button" data-clear-expiry>Clear expirations</button></div>
        </div>
        <div class="control-group">
          <span class="control-label">Share link</span>
          <div class="share-line"><span class="share-url">${shareLabel}</span><button class="button icon-button" type="button" data-copy-public aria-label="Copy share link"${copyDisabled}>${copyIcon()}</button></div>
        </div>
        <div class="danger-line"><span>Deletion is permanent.</span><button class="button danger icon-button delete-button" type="button" data-request-delete aria-label="Delete artifact">${trashIcon()}</button></div>
        <div class="confirm" data-confirm data-confirm-for="${id}" hidden role="dialog" aria-modal="true" aria-labelledby="delete-title-${id}" tabindex="-1"><div class="confirm-card"><span class="confirm-eyebrow">Permanent action</span><p id="delete-title-${id}">Delete ${name}?</p><p class="confirm-copy">This artifact and its files will be removed permanently.</p><div class="button-row"><button class="button danger" type="button" data-delete>Delete permanently</button><button class="button" type="button" data-cancel-delete>Cancel</button></div></div></div>
      </div>
    </div></td>
  </tr>`;
}

interface OwnerDocumentOptions {
  assets: OwnerAsset[];
  hasMore: boolean;
  total: number;
  offset: number;
  ownerOrigin: string;
  privateOrigin: string;
  publicOrigin: string;
  nonce: string;
  styles: string;
  script: string;
}

export function ownerDocument(options: OwnerDocumentOptions): string {
  const {
    assets,
    hasMore,
    total,
    offset,
    ownerOrigin,
    privateOrigin,
    publicOrigin,
    nonce,
    styles,
    script,
  } = options;
  const rows = assets
    .map((asset, index) =>
      assetRow(asset, offset === 0 && index === 0, privateOrigin, publicOrigin),
    )
    .join("");
  const previous =
    offset > 0
      ? `<a href="/?offset=${Math.max(0, offset - pageSize)}">← Newer</a>`
      : "<span></span>";
  const next = hasMore ? `<a href="/?offset=${offset + pageSize}">Older →</a>` : "<span></span>";
  const themeBootstrap = `<script nonce="${nonce}">try{const saved=localStorage.getItem('shlook-theme');document.documentElement.dataset.theme=saved|| (matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')}catch{document.documentElement.dataset.theme=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}</script>`;
  const selectionIcon = pencilIcon();
  const actionConfirmation = `<div class="confirm" data-action-confirm hidden role="dialog" aria-modal="true" aria-labelledby="action-confirm-title" tabindex="-1"><div class="confirm-card"><span class="confirm-eyebrow">Permanent action</span><p id="action-confirm-title" data-action-confirm-title>Confirm action?</p><p class="confirm-copy" data-action-confirm-copy></p><div class="button-row"><button class="button danger" type="button" data-action-confirm-submit>Continue</button><button class="button" type="button" data-action-confirm-cancel>Cancel</button></div></div></div>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>shlook / owner archive</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><style nonce="${nonce}">${styles}</style>${themeBootstrap}</head><body>
  <header class="masthead"><div class="shell"><div class="identity"><a class="brand" href="${escapeHtml(ownerOrigin)}/" aria-label="shlook home">${brandMark()}<span class="wordmark">shlook</span></a></div><div class="header-actions"><button class="theme-toggle upload-trigger" type="button" data-upload-open aria-label="Upload a file" aria-haspopup="dialog" aria-controls="upload-dialog" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button class="theme-toggle" type="button" data-theme-toggle aria-label="Switch to dark mode"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="moon" d="M20 15.2A8.5 8.5 0 0 1 8.8 4 8.5 8.5 0 1 0 20 15.2Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><g class="sun" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="3.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></g></svg></button></div></div></header>
  <main class="shell"><div class="page-heading"><div><h1>Artifact archive</h1><p>Inspect and manage generated artifacts.</p></div><span class="count" data-count>${total} ${total === 1 ? "artifact" : "artifacts"}</span></div>
  <section id="upload-dialog" class="upload-card" data-upload-dialog hidden role="dialog" aria-modal="true" aria-label="Upload a file" tabindex="-1"><form class="upload-form" data-upload-form data-step="file" data-private-origin="${escapeHtml(privateOrigin)}" data-public-origin="${escapeHtml(publicOrigin)}"><button class="upload-close" type="button" data-upload-close aria-label="Close upload"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button><label class="drop-zone" data-drop-zone><input data-upload-input type="file" required><span class="upload-glyph" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="drop-copy"><strong data-drop-title>Drop a file here</strong><span>or tap to choose from your computer</span></span></label><div class="upload-config" data-upload-config hidden><div class="upload-heading"><h2 id="upload-heading" tabindex="-1">Upload options</h2></div><div class="upload-fields"><label class="upload-field">Title <span>(optional)</span><input data-upload-name name="upload-name" maxlength="80" autocomplete="off"></label><label class="upload-field">Description <span>(optional)</span><textarea data-upload-description name="upload-description" maxlength="500"></textarea></label><fieldset class="upload-visibility"><legend>Visibility</legend><div class="visibility-choices"><label class="visibility-option"><input type="radio" name="upload-visibility" value="private" checked><span class="visibility-choice"><strong>Private</strong><small>You and configured agents</small></span></label><label class="visibility-option"><input type="radio" name="upload-visibility" value="secret_link"><span class="visibility-choice"><strong>Secret link</strong><small>Anyone with the URL</small></span></label><label class="visibility-option"><input type="radio" name="upload-visibility" value="public"><span class="visibility-choice"><strong>Public</strong><small>Open public URL</small></span></label></div></fieldset></div><div class="upload-actions"><button class="button primary" type="submit" data-upload-submit disabled>Upload</button><span class="upload-status" data-upload-status role="status" aria-live="polite"></span></div></div><div class="upload-progress" data-upload-progress hidden><div class="upload-spinner" aria-hidden="true"></div><div class="upload-progress-copy"><h2>Uploading…</h2><p data-upload-progress-label role="status" aria-live="polite">Creating upload…</p></div></div><div class="upload-result" data-upload-result hidden><div class="upload-result-copy"><span class="upload-result-label" data-upload-result-label>Private URL ready</span><a class="upload-result-url" data-upload-result-url target="_blank" rel="noopener noreferrer"></a></div><div class="upload-result-actions"><button class="button" type="button" data-upload-copy>${copyIcon()} Copy URL</button><button class="button" type="button" data-upload-again>Upload another</button><button class="button" type="button" data-upload-refresh>Manage in archive</button></div></div></form></section>
   <div class="toolbar" aria-label="Archive controls"><div class="selection-actions" data-selection-actions><button class="button icon-button" type="button" data-select-toggle aria-label="Select artifacts" aria-pressed="false"><span data-select-icon>${selectionIcon}</span><span data-select-done hidden>Done</span></button><button class="button danger icon-button" type="button" data-batch-delete aria-label="Delete selected artifacts" hidden>${trashIcon()}</button></div><label class="search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11.5" cy="11.5" r="7.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m17 17 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><span class="sr-only">Search artifacts</span><input data-search type="search" placeholder="Search name, description, or ID" autocomplete="off"></label><div class="filter-wrap"><span>Visibility</span><div class="custom-select filter-select" data-filter-menu data-value="all"><button class="custom-trigger" type="button" data-menu-button aria-haspopup="listbox" aria-expanded="false"><span data-menu-label>All visibility</span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button><div class="custom-options" data-menu-list role="listbox" hidden><button type="button" role="option" data-filter-option="all" aria-selected="true">All visibility</button><button type="button" role="option" data-filter-option="public" aria-selected="false">Public</button><button type="button" role="option" data-filter-option="private" aria-selected="false">Private</button><button type="button" role="option" data-filter-option="secret_link" aria-selected="false">Secret link</button></div></div></div></div>
  <section class="ledger" aria-label="Artifact archive"><table><thead><tr><th>Preview</th><th>Artifact</th><th>Visibility</th><th>Share expiration</th><th>Artifact expiration</th><th>Updated</th><th><span class="sr-only">Inspect</span></th></tr></thead><tbody>${rows}</tbody></table><div class="empty" data-empty${assets.length === 0 ? "" : " hidden"}>No live artifacts match this view.</div></section><nav class="pagination" aria-label="Archive pages">${previous}${next}</nav></main>
  <footer class="owner-footer"><a href="https://github.com/shanebishop1/shlook" target="_blank" rel="noopener noreferrer" aria-label="shlook on GitHub">${githubIcon()}</a><span>Shane Bishop <span aria-hidden="true">|</span> 2026</span></footer>
   ${actionConfirmation}<div class="toast" data-toast role="status" aria-live="polite"></div><script nonce="${nonce}">${script}</script></body></html>`;
}
