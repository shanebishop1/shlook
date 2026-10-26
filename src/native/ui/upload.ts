import { renderSafeMarkdown } from "../../markdown.ts";

/** Native preparation adapter; dialog, progress, recovery and results remain canonical. */
export function nativeUploadScript(): string {
  return (
    `const renderSafeMarkdown = ${renderSafeMarkdown.toString()};` +
    String.raw`
let nativeUploadFiles = [];
const chooseUploadFiles = (files) => {
  nativeUploadFiles = [...(files || [])];
  chooseUploadFile(nativeUploadFiles[0]);
};
uploadForm?.querySelector('[data-upload-directory]')?.addEventListener('change', (event) => chooseUploadFiles(event.target.files));
const publishUpload = async () => {
  const files = [...nativeUploadFiles];
  const maxFile = 25 * 1024 * 1024, maxTotal = 100 * 1024 * 1024, maxFiles = 500;
  if (!files.length) throw new Error('Choose one or more files');
  if (files.length > maxFiles) throw new Error('A publication can contain at most 500 files');
  if (files.some(file => file.size > maxFile)) throw new Error('A file exceeds 25 MiB');
  let total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > maxTotal) throw new Error('A publication exceeds 100 MiB');
  const prepared = new Map();
  const only = files[0], single = files.length === 1 && !only.webkitRelativePath;
  const extension = only.name.split('.').at(-1).toLowerCase();
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  const htmlDocument = body => '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body>' + body + '</body></html>';
  const addIndex = (html) => {
    if (files.length >= maxFiles) throw new Error('A publication can contain at most 500 files including its index');
    const bytes = new TextEncoder().encode(html);
    if (bytes.byteLength > maxFile || total + bytes.byteLength > maxTotal) throw new Error('Generated index exceeds publication limits');
    const index = new File([bytes], 'index.html', { type: 'text/html' });
    files.push(index);
    prepared.set(index, { path: 'index.html', bytes });
    total += bytes.byteLength;
  };
  if (single && extension === 'mdx') throw new Error('Single-file MDX is unsupported');
  if (single && extension === 'md') {
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(await only.arrayBuffer()); }
    catch { throw new Error('Markdown must contain valid UTF-8'); }
    const bytes = new TextEncoder().encode(htmlDocument('<main>' + renderSafeMarkdown(source) + '</main>'));
    if (bytes.byteLength > maxFile) throw new Error('Generated Markdown HTML exceeds 25 MiB');
    total = total - only.size + bytes.byteLength;
    if (total > maxTotal) throw new Error('A publication exceeds 100 MiB after Markdown conversion');
    prepared.set(only, { path: only.name + '.html', bytes });
  } else if (single && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'].includes(extension)) {
    addIndex(htmlDocument('<img alt="' + escape(only.name) + '" src="' + escape(encodeURIComponent(only.name)) + '">'));
  }
  if (!(single && extension === 'md') && files.every(file => /\.(?:md|mdx)$/i.test(file.webkitRelativePath || file.name))) {
    addIndex(htmlDocument('<p>Files in this directory are preserved as inert downloads; directory Markdown is not rendered.</p>'));
  }
  let id;
  try {
    setUploadProgress('Creating upload...');
    const created = await ownerRequest('/api/assets', { method: 'POST', body: JSON.stringify({ name: uploadName.value.trim() || uploadName.dataset.fallback, description: uploadDescription.value.trim() || null, visibility: 'private' }) });
    id = created.asset?.id;
    if (typeof id !== 'string') throw new Error('Create response did not include an asset ID.');
    const manifest = [];
    for (const file of files) {
      const item = prepared.get(file), path = item?.path || file.webkitRelativePath || file.name;
      const content = item?.bytes || new Uint8Array(await file.arrayBuffer());
      if (content.byteLength > maxFile) throw new Error('A file exceeds 25 MiB');
      setUploadProgress('Uploading ' + path + '...');
      const uploaded = await ownerRequest('/api/assets/' + id + '/files/' + path.split('/').map(encodeURIComponent).join('/'), { method: 'PUT', body: content, headers: { 'Content-Type': 'application/octet-stream' } });
      if (typeof uploaded.file?.uploadId !== 'string') throw new Error('Upload response did not include a file ID.');
      manifest.push({ path, uploadId: uploaded.file.uploadId });
    }
    const entry = manifest.find(item => /^(index|default)\.html?$/i.test(item.path.split('/').at(-1))) || manifest.find(item => /\.html?$/i.test(item.path)) || manifest.find(item => !/\.(?:md|mdx|svg)$/i.test(item.path)) || manifest[0];
    setUploadProgress('Finishing upload...');
    await ownerRequest('/api/assets/' + id + '/finalize', { method: 'POST', body: JSON.stringify({ entrypoint: entry.path, files: manifest }) });
    return { resultUrl: uploadForm.dataset.privateOrigin + '/assets/' + id + '/', resultLabel: 'Private URL ready' };
  } catch (error) {
    if (id) try { await ownerRequest('/api/assets/' + id, { method: 'DELETE' }); } catch {}
    throw error;
  }
};`
  );
}
