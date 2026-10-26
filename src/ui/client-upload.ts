export function uploadClientScript(uploadScript?: string): string {
  return `
const setUploadStatus = (message, error = false) => {
  uploadStatus.textContent = message;
  uploadStatus.classList.toggle('error', error);
};
const setUploadProgress = (message) => {
  if (uploadProgressLabel) uploadProgressLabel.textContent = message;
};
const openUpload = () => {
  uploadDialog.hidden = false;
  document.body.classList.add('upload-modal-open');
  uploadOpen.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => uploadDialog.focus());
};
const resetUpload = () => {
  selectedUploadFile = undefined;
  uploadInput.value = '';
  uploadName.value = '';
  uploadName.placeholder = '';
  delete uploadName.dataset.fallback;
  uploadDescription.value = '';
  uploadForm.dataset.step = 'file';
  dropZone.hidden = false;
  dropZone.style.display = '';
  uploadConfig.hidden = true;
  uploadProgress.hidden = true;
  uploadResult.hidden = true;
  uploadSubmit.disabled = true;
  const privateOption = uploadForm.querySelector('[name="upload-visibility"][value="private"]');
  if (privateOption) privateOption.checked = true;
  uploadForm.querySelectorAll('input[type="file"]').forEach((input) => { input.value = ''; });
  setUploadStatus('');
};
const closeUpload = () => {
  if (uploadBusy) return;
  resetUpload();
  uploadDialog.hidden = true;
  document.body.classList.remove('upload-modal-open');
  uploadOpen.setAttribute('aria-expanded', 'false');
  uploadOpen.focus();
};
const trapDialogFocus = (dialog, event) => {
  if (event.key !== 'Tab') return;
  const focusable = [...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),summary,a[href]')]
    .filter((element) => element.offsetParent !== null);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
};
const uploadFileFromDrop = (dataTransfer) => {
  if (!dataTransfer) return;
  const directFile = dataTransfer.files && dataTransfer.files[0];
  if (directFile) return directFile;
  for (const item of dataTransfer.items || []) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) return file;
  }
};
const uploadDragHasFile = (dataTransfer) => {
  if (!dataTransfer) return false;
  if (dataTransfer.files && dataTransfer.files.length > 0) return true;
  for (const item of dataTransfer.items || []) {
    if (item.kind === 'file') return true;
  }
  return [...(dataTransfer.types || [])].includes('Files');
};
const chooseUploadFile = (file) => {
  if (!file) return;
  selectedUploadFile = file;
  const base = (file.name.replace(/\\.[^.]+$/, '').trim() || file.name || 'Upload').slice(0, 80);
  uploadName.value = '';
  uploadName.dataset.fallback = base;
  uploadName.placeholder = base;
  uploadForm.dataset.step = 'options';
  dropZone.hidden = true;
  dropZone.style.display = 'none';
  uploadConfig.hidden = false;
  uploadSubmit.disabled = false;
  uploadProgress.hidden = true;
  uploadResult.hidden = true;
  setUploadStatus('');
  requestAnimationFrame(() => uploadConfig.querySelector('h2').focus());
};
${uploadScript ?? defaultUploadScript()}`;
}

function defaultUploadScript(): string {
  return `
const chooseUploadFiles = (files) => chooseUploadFile(files && files[0]);
const publishUpload = async (file) => {
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
    return { resultUrl, resultLabel };
  } catch (error) {
    if (id) try { await ownerRequest('/api/assets/' + id, { method: 'DELETE' }); } catch {}
    throw error;
  }
};`;
}
