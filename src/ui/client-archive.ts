export function archiveClientScript(): string {
  return `
const closeConfirmation = (confirmation) => {
  confirmation.hidden = true;
  document.body.classList.remove('confirm-open');
  document.querySelector('[data-detail="' + confirmation.dataset.confirmFor + '"] [data-request-delete]').focus();
};
const selectedItems = () => [...document.querySelectorAll('[data-select-item]:checked')];
const syncSelection = () => {
  const selected = selectedItems();
  batchDelete.hidden = !selectMode || selected.length === 0;
  batchDelete.disabled = selected.length === 0;
};
const setSelectMode = (enabled) => {
  selectMode = enabled;
  document.body.classList.toggle('selection-mode', enabled);
  selectIcon.hidden = enabled;
  selectDone.hidden = !enabled;
  selectToggle.setAttribute('aria-label', enabled ? 'Done selecting' : 'Select artifacts');
  selectToggle.setAttribute('aria-pressed', String(enabled));
  selectToggle.classList.toggle('icon-button', !enabled);
  if (!enabled) document.querySelectorAll('[data-select-item]').forEach((item) => { item.checked = false; });
  syncSelection();
};
const uploadVisibility = () => uploadForm.querySelector('[name="upload-visibility"]:checked').value;
const cardForId = (id) => document.querySelector('[data-detail="' + id + '"]');
const loadPreviewFrame = (frame) => {
  const media = frame.parentElement;
  const renderWidth = 1280;
  if (frame.hasAttribute('src')) return;
  const scale = media.clientWidth / renderWidth;
  if (scale <= 0 || media.clientHeight <= 0) return;
  frame.style.width = renderWidth + 'px';
  frame.style.height = Math.ceil(media.clientHeight / scale) + 'px';
  frame.style.transform = 'scale(' + scale + ')';
  frame.src = frame.dataset.src;
};
const fitPreviewFrame = (frame, loadWhenReady = true) => {
  const media = frame.parentElement;
  const renderWidth = 1280;
  if (frame.dataset.fitted) {
    if (loadWhenReady) loadPreviewFrame(frame);
    return;
  }
  frame.dataset.fitted = '1';
  const resize = () => {
    const scale = media.clientWidth / renderWidth;
    if (scale <= 0 || media.clientHeight <= 0) return;
    frame.style.width = renderWidth + 'px';
    frame.style.height = Math.ceil(media.clientHeight / scale) + 'px';
    frame.style.transform = 'scale(' + scale + ')';
    if (loadWhenReady) loadPreviewFrame(frame);
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(resize).observe(media);
  else addEventListener('resize', resize, { passive: true });
  requestAnimationFrame(resize);
};
const mobilePreviewObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const frame = entry.target.querySelector('[data-preview-fallback]');
    if (entry.isIntersecting) fitPreviewFrame(frame);
    else frame.removeAttribute('src');
  }
}, { rootMargin: '160px 0px' }) : null;
const showPreviewFallback = (image) => {
  const media = image.parentElement;
  const frame = media.querySelector('[data-preview-fallback]');
  if (!frame.hidden) return;
  image.hidden = true;
  if (innerWidth < 901 && !media.hasAttribute('data-preview-large')) {
    frame.hidden = false;
    fitPreviewFrame(frame, mobilePreviewObserver === null);
    mobilePreviewObserver?.observe(media);
    return;
  }
  frame.hidden = false;
  fitPreviewFrame(frame);
};
const bindPreviewImages = (root = document) => root.querySelectorAll('[data-preview-image]').forEach((image) => {
  image.addEventListener('error', () => showPreviewFallback(image), { once: true });
  if (image.complete && image.naturalWidth === 0) showPreviewFallback(image);
});
const releaseDetailPreview = (detail) => {
  if (innerWidth >= 901) return;
  detail.querySelector('[data-preview-large] [data-preview-fallback]')?.removeAttribute('src');
};
const bindSelectionItems = (root = document) => root.querySelectorAll('[data-select-item]').forEach((item) => item.addEventListener('change', syncSelection));
const closeMenus = (except) => {
  document.querySelectorAll('[data-menu-list]:not([hidden])').forEach((list) => {
    if (list === except) return;
    list.hidden = true;
    list.parentElement.querySelector('[data-menu-button]').setAttribute('aria-expanded', 'false');
  });
};
const toggleMenu = (menu) => {
  const list = menu.querySelector('[data-menu-list]');
  const open = list.hidden;
  closeMenus(open ? list : null);
  list.hidden = !open;
  menu.querySelector('[data-menu-button]').setAttribute('aria-expanded', String(open));
  if (open) {
    const selected = list.querySelector('[aria-selected="true"]:not(:disabled)') || list.querySelector('[role="option"]:not(:disabled)');
    selected?.focus();
  }
};
const setMenuValue = (menu, value) => {
  menu.dataset.value = value;
  menu.querySelector('[data-menu-label]').textContent = value === 'all' ? 'All visibility' : labels[value];
  menu.querySelectorAll('[role="option"]').forEach((option) => option.setAttribute('aria-selected', String((option.dataset.visibilityOption || option.dataset.filterOption) === value)));
};
const filterRecords = () => {
  const query = document.querySelector('[data-search]').value.trim().toLowerCase();
  const visibility = filterMenu.dataset.value;
  let visible = 0;
  for (const row of records) {
    const match = (!query || row.dataset.search.includes(query)) && (visibility === 'all' || row.dataset.visibility === visibility);
    row.hidden = !match;
    const detail = cardForId(row.dataset.record);
    if (!match) detail.hidden = true;
    else if (row.classList.contains('is-open')) detail.hidden = false;
    if (match) visible++;
  }
  empty.hidden = visible !== 0;
};
const refreshArchive = async () => {
  const response = await fetch('/');
  if (!response.ok) throw new Error('Archive refresh failed.');
  const nextDocument = new DOMParser().parseFromString(await response.text(), 'text/html');
  const nextBody = nextDocument.querySelector('.ledger tbody');
  const nextCount = nextDocument.querySelector('[data-count]');
  const nextPagination = nextDocument.querySelector('.pagination');
  if (!nextBody || !nextCount || !nextPagination) throw new Error('Archive refresh failed.');
  document.querySelector('.ledger tbody').replaceWith(nextBody);
  count.textContent = nextCount.textContent;
  pagination.innerHTML = nextPagination.innerHTML;
  records.splice(0, records.length, ...document.querySelectorAll('[data-record]'));
  bindSelectionItems(nextBody);
  bindPreviewImages(nextBody);
  document.querySelector('input[data-search]').value = '';
  setMenuValue(filterMenu, 'all');
  filterRecords();
  history.replaceState(null, '', '/');
};
const shareUrlFor = (card, value) => value === 'public' ? card.dataset.publicUrl : value === 'secret_link' ? card.dataset.secretUrl : '';
const syncShare = (row, card, value) => {
  const url = shareUrlFor(card, value);
  card.querySelector('.share-url').textContent = url || (value === 'secret_link' ? 'Rotate once to recover this existing secret link' : 'Available when this artifact is public');
  card.querySelector('[data-copy-public]').disabled = !url;
  const rowCopy = row.querySelector('[data-copy-row]');
  rowCopy.hidden = value === 'private';
  rowCopy.disabled = !url;
};
const syncVisibility = (id, value) => {
  const row = document.querySelector('[data-record="' + id + '"]');
  const card = cardForId(id);
  row.dataset.visibility = value;
  row.dataset.search = row.dataset.searchText + ' ' + value;
  document.querySelectorAll('[data-visibility-menu][data-asset-id="' + id + '"]').forEach((menu) => setMenuValue(menu, value));
  syncShare(row, card, value);
  filterRecords();
};
const toggle = (row) => {
  const detail = cardForId(row.dataset.record);
  const open = !row.classList.contains('is-open');
  for (const other of records) {
    if (other === row) continue;
    other.classList.remove('is-open');
    other.setAttribute('aria-selected', 'false');
    other.querySelector('[data-inspect][aria-expanded]').setAttribute('aria-expanded', 'false');
    const otherDetail = cardForId(other.dataset.record);
    otherDetail.hidden = true;
    releaseDetailPreview(otherDetail);
  }
  row.classList.toggle('is-open', open);
  row.setAttribute('aria-selected', String(open));
  row.querySelector('[data-inspect][aria-expanded]').setAttribute('aria-expanded', String(open));
  detail.hidden = !open;
  if (!open) releaseDetailPreview(detail);
  const detailFrame = detail.querySelector('[data-preview-large] [data-preview-fallback]');
  if (open && detailFrame && !detailFrame.hidden && !detailFrame.hasAttribute('src')) {
    detailFrame.src = detailFrame.dataset.src;
  }
  if (open && innerWidth < 901) row.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
};
const setTheme = (theme) => {
  document.documentElement.dataset.theme = theme;
  const dark = theme === 'dark';
  document.querySelector('[data-theme-toggle]').setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  try { localStorage.setItem('shlook-theme', theme); } catch {}
};
let initialTheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
try { initialTheme = localStorage.getItem('shlook-theme') || initialTheme; } catch {}
setTheme(initialTheme);
document.querySelector('[data-theme-toggle]').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));`;
}
