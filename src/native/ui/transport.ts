/** All native mutations, including binary uploads, pass through this CSRF boundary. */
export function nativeRequestScript(): string {
  return `
let sessionRecoveryStarted = false;
const recoverNativeSession = () => {
  if (!sessionRecoveryStarted) { sessionRecoveryStarted = true; location.reload(); }
  return new Error('Your session expired. Sign in again.');
};
const ownerRequest = async (path, init = {}) => {
  const headers = new Headers(init.headers);
  if (typeof init.body === 'string' && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (!['GET', 'HEAD'].includes((init.method || 'GET').toUpperCase())) {
    const session = await fetch('/api/session', { credentials: 'same-origin' });
    if (session.status === 401) throw recoverNativeSession();
    if (!session.ok) throw new Error('Your session expired. Sign in again.');
    const { csrfToken } = await session.json();
    if (typeof csrfToken !== 'string' || !csrfToken) throw new Error('Session verification failed.');
    headers.set('X-Shlook-CSRF', csrfToken);
  }
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  if (response.status === 401) throw recoverNativeSession();
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    const code = body.error || ('request_failed_' + response.status);
    const error = new Error(errorMessage(code));
    error.code = code;
    throw error;
  }
  return body;
};
document.querySelector('[data-logout]')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try { await ownerRequest('/api/session', { method: 'DELETE' }); location.replace('/login'); }
  catch (error) { setStatus(null, error.message, true); button.disabled = false; }
});`;
}

/** Native list responses omit entrypoints; resolve once per asset for both canonical previews. */
export function nativePreviewScript(): string {
  return `
const previewEntrypoints = new Map();
const resolvePreview = async (image) => {
  const id = image.dataset.previewEntrypoint;
  if (!previewEntrypoints.has(id)) {
    const pending = ownerRequest('/api/assets/' + encodeURIComponent(id)).then(body => {
      const entrypoint = body.asset?.entrypoint;
      if (typeof entrypoint !== 'string' || !entrypoint) throw new Error('Preview unavailable');
      return '/preview/assets/' + encodeURIComponent(id) + '/' + entrypoint.split('/').map(encodeURIComponent).join('/');
    });
    previewEntrypoints.set(id, pending);
    pending.catch(() => previewEntrypoints.delete(id));
  }
  const url = await previewEntrypoints.get(id);
  if (!image.isConnected) return;
  image.parentElement.querySelector('[data-preview-fallback]').dataset.src = url;
  image.src = url;
};`;
}
