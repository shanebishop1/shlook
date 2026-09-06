export function sharedClientScript(): string {
  return `
const records = [...document.querySelectorAll('[data-record]')];
const count = document.querySelector('[data-count]');
const empty = document.querySelector('[data-empty]');
const toast = document.querySelector('[data-toast]');
const filterMenu = document.querySelector('[data-filter-menu]');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const uploadDialog = document.querySelector('[data-upload-dialog]');
const uploadOpen = document.querySelector('[data-upload-open]');
const uploadClose = document.querySelector('[data-upload-close]');
const uploadForm = document.querySelector('[data-upload-form]');
const uploadConfig = uploadForm.querySelector('[data-upload-config]');
const uploadInput = uploadForm.querySelector('[data-upload-input]');
const uploadName = uploadForm.querySelector('[data-upload-name]');
const uploadDescription = uploadForm.querySelector('[data-upload-description]');
const uploadSubmit = uploadForm.querySelector('[data-upload-submit]');
const uploadStatus = uploadForm.querySelector('[data-upload-status]');
const uploadResult = uploadForm.querySelector('[data-upload-result]');
const uploadResultUrl = uploadForm.querySelector('[data-upload-result-url]');
const uploadProgress = uploadForm.querySelector('[data-upload-progress]');
const uploadProgressLabel = uploadForm.querySelector('[data-upload-progress-label]');
const dropZone = uploadForm.querySelector('[data-drop-zone]');
const selectToggle = document.querySelector('[data-select-toggle]');
const selectIcon = selectToggle.querySelector('[data-select-icon]');
const selectDone = selectToggle.querySelector('[data-select-done]');
const batchDelete = document.querySelector('[data-batch-delete]');
const actionConfirm = document.querySelector('[data-action-confirm]');
let selectedUploadFile;
let uploadBusy = false;
let selectMode = false;
let toastTimer;
let pendingAction;

const labels = { private: 'Private', secret_link: 'Secret link', public: 'Public' };
const errorMessage = (code) => code === 'not_found'
  ? 'Artifact no longer exists. Refreshing...'
  : code === 'secret_required'
    ? 'Issue a secret link before selecting Secret link.'
    : code === 'asset_not_live'
      ? 'This artifact is no longer active.'
      : code === 'secret_encryption_unavailable'
        ? 'Secret-link encryption is not configured.'
        : code.replace(/_/g, ' ');

const setStatus = (_card, message, error = false) => {
  if (message.startsWith('Secret URL')) {
    message = message.startsWith('Secret URL copied') ? 'Secret link copied.' : 'Secret link ready.';
  }
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), error ? 4000 : 2400);
};

const reportError = (card, error) => {
  setStatus(card, error.message, true);
  if (error.code === 'not_found') setTimeout(() => location.reload(), 900);
};

const copyText = async (text) => {
  if (navigator.clipboard && isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement('textarea');
  input.value = text;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('Copy failed. Select and copy the URL manually.');
};

const mutate = async (card, path, init) => {
  setStatus(card, 'Working...');
  const response = await fetch('/api/assets/' + card.dataset.detail + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    const code = body.error || ('request_failed_' + response.status);
    const failure = new Error(errorMessage(code));
    failure.code = code;
    throw failure;
  }
  if (typeof body.url === 'string') card.dataset.secretUrl = body.url;
  if (path === '/secret' && init.method === 'DELETE') card.dataset.secretUrl = '';
  return body;
};

const ownerRequest = async (path, init = {}) => {
  const response = await fetch(path, init);
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    const code = body.error || ('request_failed_' + response.status);
    throw new Error(errorMessage(code));
  }
  return body;
};`;
}
