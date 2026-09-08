export function initClientScript(): string {
  return `
uploadOpen.addEventListener('click', openUpload);
uploadClose.addEventListener('click', closeUpload);
selectToggle.addEventListener('click', () => setSelectMode(!selectMode));
batchDelete.addEventListener('click', async () => {
  const items = selectedItems();
  if (items.length === 0) return;
  openActionConfirmation('Delete ' + items.length + ' selected ' + (items.length === 1 ? 'artifact' : 'artifacts') + '?', 'These artifacts and their files will be removed permanently.', async () => {
    batchDelete.disabled = true;
    try {
      await Promise.all(items.map((item) => ownerRequest('/api/assets/' + item.closest('[data-record]').dataset.record, { method: 'DELETE' })));
      location.reload();
    } catch (error) {
      setStatus(null, error instanceof Error ? error.message : 'Batch delete failed.', true);
      batchDelete.disabled = false;
    }
  });
});
const openActionConfirmation = (title, copy, action) => {
  pendingAction = action;
  actionConfirm.querySelector('[data-action-confirm-title]').textContent = title;
  actionConfirm.querySelector('[data-action-confirm-copy]').textContent = copy;
  actionConfirm.hidden = false;
  document.body.classList.add('confirm-open');
  requestAnimationFrame(() => actionConfirm.querySelector('[data-action-confirm-submit]').focus());
};
const closeActionConfirmation = () => {
  actionConfirm.hidden = true;
  pendingAction = undefined;
  document.body.classList.remove('confirm-open');
  batchDelete.focus();
};
actionConfirm.addEventListener('keydown', (event) => trapDialogFocus(actionConfirm, event));
actionConfirm.addEventListener('click', (event) => event.stopPropagation());
actionConfirm.querySelector('[data-action-confirm-cancel]').addEventListener('click', closeActionConfirmation);
actionConfirm.querySelector('[data-action-confirm-submit]').addEventListener('click', async () => {
  const action = pendingAction;
  if (!action) return;
  actionConfirm.querySelector('[data-action-confirm-submit]').disabled = true;
  try { closeActionConfirmation(); await action(); }
  finally { actionConfirm.querySelector('[data-action-confirm-submit]').disabled = false; }
});
uploadDialog.addEventListener('click', (event) => { event.stopPropagation(); });
uploadDialog.addEventListener('keydown', (event) => trapDialogFocus(uploadDialog, event));
document.querySelectorAll('[data-confirm]').forEach((confirmation) => confirmation.addEventListener('keydown', (event) => trapDialogFocus(confirmation, event)));
document.addEventListener('click', async (event) => {
  const request = event.target.closest('[data-request-delete]');
  if (request) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const id = request.closest('[data-detail]').dataset.detail;
    const confirmation = document.querySelector('[data-confirm-for="' + id + '"]');
    document.body.appendChild(confirmation);
    confirmation.hidden = false;
    document.body.classList.add('confirm-open');
    requestAnimationFrame(() => confirmation.querySelector('[data-delete]').focus());
    return;
  }
  const cancel = event.target.closest('[data-cancel-delete]');
  if (cancel) {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeConfirmation(cancel.closest('[data-confirm]'));
    return;
  }
  const deletion = event.target.closest('[data-delete]');
  if (deletion) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const confirmation = deletion.closest('[data-confirm]');
    deletion.disabled = true;
    try {
      await mutate(cardForId(confirmation.dataset.confirmFor), '', { method: 'DELETE' });
      location.reload();
    } catch (error) {
      reportError(cardForId(confirmation.dataset.confirmFor), error);
      deletion.disabled = false;
    }
    return;
  }
  const confirmation = event.target.closest('[data-confirm]');
  if (confirmation && event.target === confirmation) {
    event.stopImmediatePropagation();
    closeConfirmation(confirmation);
  }
}, true);
document.querySelectorAll('input[data-iso]').forEach((input) => {
  if (!input.dataset.iso) return;
  const date = new Date(input.dataset.iso);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  input.value = local.toISOString().slice(0, 16);
});
const localDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const localTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
document.querySelectorAll('[data-local-time]').forEach((element) => {
  const date = new Date(element.dateTime);
  if (Number.isNaN(date.getTime())) return;
  const zone = document.createElement('span');
  zone.className = 'meta-sub';
  zone.textContent = localTime.format(date);
  element.textContent = localDate.format(date);
  element.append(zone);
});
uploadInput.required = false;
uploadInput.addEventListener('change', () => chooseUploadFile(uploadInput.files && uploadInput.files[0]));
bindSelectionItems();
document.addEventListener('click', (event) => {
  if (!selectMode) return;
  const row = event.target.closest('[data-record]');
  if (!row || event.target.closest('a,button,input')) return;
  const item = row.querySelector('[data-select-item]');
  item.checked = !item.checked;
  syncSelection();
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);
['dragenter', 'dragover'].forEach((type) => dropZone.addEventListener(type, (event) => {
  event.preventDefault();
  dropZone.classList.add('is-dragging');
}));
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('is-dragging'));
document.addEventListener('dragover', (event) => {
  if (!uploadDragHasFile(event.dataTransfer)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('drop', (event) => {
  if (!uploadDragHasFile(event.dataTransfer)) return;
  event.preventDefault();
  dropZone.classList.remove('is-dragging');
  if (uploadBusy) return;
  const file = uploadFileFromDrop(event.dataTransfer);
  resetUpload();
  if (uploadDialog.hidden) openUpload();
  if (file) chooseUploadFile(file);
  else setUploadStatus('That drag did not include a usable file. Try choosing it instead.', true);
});
uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = selectedUploadFile;
  if (!file) {
    setUploadStatus('Choose a file first.', true);
    uploadInput.click();
    return;
  }
  if (!uploadForm.reportValidity()) return;
  uploadBusy = true;
  uploadClose.disabled = true;
  uploadSubmit.disabled = true;
  uploadForm.dataset.step = 'uploading';
  dropZone.hidden = true;
  dropZone.style.display = 'none';
  uploadConfig.hidden = true;
  uploadResult.hidden = true;
  uploadProgress.hidden = false;
  let id;
  try {
    setUploadProgress('Creating upload...');
    const created = await ownerRequest('/api/assets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: uploadName.value.trim() || uploadName.dataset.fallback, description: uploadDescription.value.trim() || null }) });
    id = created.asset && created.asset.id;
    if (typeof id !== 'string') throw new Error('Create response did not include an asset ID.');
    setUploadProgress('Uploading ' + file.name + '...');
    const uploaded = await ownerRequest('/api/assets/' + id + '/files/' + encodeURIComponent(file.name), { method: 'PUT', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file });
    if (!uploaded.file || typeof uploaded.file.uploadId !== 'string') throw new Error('Upload response did not include a file ID.');
    setUploadProgress('Finishing upload...');
    await ownerRequest('/api/assets/' + id + '/finalize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entrypoint: file.name, files: [uploaded.file] }) });
    const visibility = uploadVisibility();
    let resultUrl = uploadForm.dataset.privateOrigin + '/assets/' + id + '/';
    let resultLabel = 'Private URL ready';
    if (visibility === 'public') {
      await ownerRequest('/api/assets/' + id + '/visibility', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visibility: 'public' }) });
      resultUrl = uploadForm.dataset.publicOrigin + '/assets/' + id + '/';
      resultLabel = 'Public URL ready';
    } else if (visibility === 'secret_link') {
      const secret = await ownerRequest('/api/assets/' + id + '/secret?mode=create', { method: 'POST' });
      if (typeof secret.url !== 'string') throw new Error('Secret-link response did not include a URL.');
      resultUrl = secret.url;
      resultLabel = 'Secret URL ready';
    }
    try { await refreshArchive(); } catch {}
    uploadResultUrl.href = resultUrl;
    uploadResultUrl.textContent = resultUrl;
    uploadForm.querySelector('[data-upload-result-label]').textContent = resultLabel;
    uploadForm.dataset.step = 'done';
    uploadProgress.hidden = true;
    uploadConfig.hidden = true;
    uploadResult.hidden = false;
    uploadForm.querySelector('[data-upload-copy]').focus();
  } catch (error) {
    if (id) try { await ownerRequest('/api/assets/' + id, { method: 'DELETE' }); } catch {}
    uploadForm.dataset.step = 'options';
    uploadProgress.hidden = true;
    uploadConfig.hidden = false;
    uploadResult.hidden = true;
    setUploadStatus(error instanceof Error ? error.message : 'Upload failed.', true);
  } finally {
    uploadBusy = false;
    uploadClose.disabled = false;
    uploadSubmit.disabled = false;
  }
});
uploadForm.querySelector('[data-upload-copy]').addEventListener('click', async () => {
  try {
    await copyText(uploadResultUrl.href);
    uploadForm.querySelector('[data-upload-result-label]').textContent = 'URL copied.';
  } catch (error) {
    uploadForm.querySelector('[data-upload-result-label]').textContent = error instanceof Error ? error.message : 'Copy failed.';
  }
});
uploadForm.querySelector('[data-upload-again]').addEventListener('click', () => { resetUpload(); requestAnimationFrame(() => uploadDialog.focus()); });
document.querySelector('[data-search]').addEventListener('input', filterRecords);
document.addEventListener('click', (event) => {
  const link = event.target.closest('.pagination a');
  if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigateArchive(link.href, 'push');
}, true);
addEventListener('popstate', () => navigateArchive(location.href, 'none'));
document.addEventListener('keydown', (event) => {
  const menu = event.target.closest?.('.custom-select');
  if (event.key === 'Escape') {
    const confirmation = document.querySelector('[data-confirm]:not([hidden])');
    if (confirmation) { closeConfirmation(confirmation); return; }
    if (!uploadDialog.hidden) { closeUpload(); return; }
    closeMenus();
    menu?.querySelector('[data-menu-button]')?.focus();
    return;
  }
  if (!menu || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  event.preventDefault();
  const options = [...menu.querySelectorAll('[role="option"]:not(:disabled)')];
  const index = options.indexOf(document.activeElement);
  options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus();
});
document.addEventListener('click', async (event) => {
  const copy = event.target.closest('[data-copy-row],[data-copy-public]');
  if (!copy) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const row = copy.closest('[data-record]') || document.querySelector('[data-record="' + copy.closest('[data-detail]').dataset.detail + '"]');
  const card = cardForId(row.dataset.record);
  const url = shareUrlFor(card, row.dataset.visibility);
  if (!url) return;
  try { await copyText(url); setStatus(card, 'Share link copied.'); }
  catch (error) { reportError(card, error); }
}, true);
document.addEventListener('click', async (event) => {
  const menuButton = event.target.closest('[data-menu-button]');
  if (menuButton) { toggleMenu(menuButton.closest('.custom-select')); return; }
  const filterOption = event.target.closest('[data-filter-option]');
  if (filterOption) { setMenuValue(filterMenu, filterOption.dataset.filterOption); closeMenus(); filterRecords(); return; }
  const visibilityOption = event.target.closest('[data-visibility-option]');
  if (visibilityOption) {
    const menu = visibilityOption.closest('[data-visibility-menu]');
    const id = menu.dataset.assetId;
    const row = document.querySelector('[data-record="' + id + '"]');
    const card = cardForId(id);
    const previous = row.dataset.visibility;
    const value = visibilityOption.dataset.visibilityOption;
    const needsSecret = value === 'secret_link' && card.dataset.hasSecret !== '1';
    const path = needsSecret ? '/secret?mode=create' : '/visibility';
    const init = needsSecret ? { method: 'POST', body: '{}' } : { method: 'PATCH', body: JSON.stringify({ visibility: value }) };
    closeMenus();
    syncVisibility(id, value);
    menu.querySelector('[data-menu-button]').disabled = true;
    try {
      await mutate(card, path, init);
      if (needsSecret) {
        card.dataset.hasSecret = '1';
        const secretButton = card.querySelector('[data-secret="create"]');
        secretButton.dataset.secret = 'rotate';
        secretButton.textContent = 'Rotate secret link';
        card.querySelector('[data-secret="revoke"]').hidden = false;
        syncVisibility(id, value);
      }
      setStatus(card, 'Visibility updated.');
    } catch (error) {
      syncVisibility(id, previous);
      reportError(card, error);
    } finally { menu.querySelector('[data-menu-button]').disabled = false; }
    return;
  }
  const inspect = event.target.closest('[data-inspect]');
  if (inspect) { toggle(inspect.closest('[data-record]')); return; }
  const row = event.target.closest('[data-record]');
  if (row && !event.target.closest('a,button,input')) { closeMenus(); toggle(row); return; }
  const button = event.target.closest('button');
  if (!button) { closeMenus(); return; }
  const card = button.closest('[data-detail]');
  if (!card) return;
  button.disabled = true;
  try {
    if (button.dataset.secret) {
      const action = button.dataset.secret;
      if (action === 'revoke') {
        const current = document.querySelector('[data-record="' + card.dataset.detail + '"]').dataset.visibility;
        await mutate(card, '/secret', { method: 'DELETE' });
        card.dataset.hasSecret = '0';
        syncVisibility(card.dataset.detail, current === 'secret_link' ? 'private' : current);
        setStatus(card, 'Secret revoked.');
        button.hidden = true;
        card.querySelector('[data-secret="rotate"]').dataset.secret = 'create';
        card.querySelector('[data-secret="create"]').textContent = 'Issue secret link';
      } else {
        const body = await mutate(card, '/secret?mode=' + action, { method: 'POST', body: '{}' });
        card.dataset.hasSecret = '1';
        syncVisibility(card.dataset.detail, 'secret_link');
        let copied = false;
        try { await navigator.clipboard.writeText(body.url); copied = true; } catch {}
        setStatus(card, (copied ? 'Secret URL copied. ' : 'Secret URL: ') + body.url);
        button.dataset.secret = 'rotate';
        button.textContent = 'Rotate secret link';
        card.querySelector('[data-secret="revoke"]').hidden = false;
      }
    } else if (button.hasAttribute('data-expiry')) {
      const value = (input) => input.value ? new Date(input.value).toISOString() : null;
      const hard = value(card.querySelector('[data-hard-expiry]'));
      if (hard) {
        openActionConfirmation('Apply permanent expiration?', 'The artifact and its files will be deleted at the selected time.', async () => {
          await mutate(card, '/expiry', { method: 'PATCH', body: JSON.stringify({ shareExpiresAt: value(card.querySelector('[data-share-expiry]')), hardExpiresAt: hard }) });
          setStatus(card, 'Expiration policy updated.');
          setTimeout(() => location.reload(), 500);
        });
        return;
      }
      await mutate(card, '/expiry', { method: 'PATCH', body: JSON.stringify({ shareExpiresAt: value(card.querySelector('[data-share-expiry]')), hardExpiresAt: hard }) });
      setStatus(card, 'Expiration policy updated.');
      setTimeout(() => location.reload(), 500);
    } else if (button.hasAttribute('data-clear-expiry')) {
      await mutate(card, '/expiry', { method: 'PATCH', body: JSON.stringify({ shareExpiresAt: null, hardExpiresAt: null }) });
      setStatus(card, 'Expirations cleared.');
      setTimeout(() => location.reload(), 350);
    } else if (button.hasAttribute('data-copy-public')) {
      await navigator.clipboard.writeText(card.dataset.publicUrl);
      setStatus(card, 'Share link copied.');
    }
  } catch (error) { reportError(card, error); }
  finally { if (document.contains(button)) button.disabled = false; }
});
filterRecords();
bindPreviewImages();`;
}
