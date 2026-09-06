export function uploadClientScript(): string {
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
  uploadForm.querySelector('[name="upload-visibility"][value="private"]').checked = true;
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
};`;
}
