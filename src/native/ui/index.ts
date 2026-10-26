import type { IncomingMessage, ServerResponse } from "node:http";
import { renderSafeMarkdown } from "../../markdown.ts";

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'";
const headers = (response: ServerResponse, type: string) => {
  response.setHeader("Content-Type", type);
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", CSP);
  response.setHeader("Referrer-Policy", "no-referrer");
};
const shell = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title} · Shlook</title><link rel="stylesheet" href="/ui/style.css"></head><body><main id="archive">${body}</main><script src="/ui/app.js" defer></script></body></html>`;
const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const script = String.raw`(()=>{
const $=s=>document.querySelector(s), api=async(path,opts={})=>{const r=await fetch(path,{credentials:'same-origin',...opts,headers:{...(opts.body instanceof FormData?{}:{'Content-Type':'application/json'}),...(opts.headers||{})}});if(!r.ok)throw Error((await r.json().catch(()=>({error:'request_failed'}))).error||'request_failed');return r.status===204?null:r.json()};
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const csrf=async()=>{const s=await api('/api/session');return s.csrfToken};
if($('#login')){const form=$('#login');form.addEventListener('submit',async e=>{e.preventDefault();const input=$('#token'),button=form.querySelector('button'),message=$('#message');let token=input.value;input.value='';button.disabled=true;message.textContent='Signing in…';try{const r=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json','X-Shlook-Login':'1'},body:JSON.stringify({token}),credentials:'same-origin'});token='';if(!r.ok)throw Error('Sign-in failed');const u=new URL(location.href),ret=u.searchParams.get('return');location.replace(ret==='/archive'?'/archive':'/')}catch(err){token='';message.textContent=err.message;button.disabled=false}});return}
let next=0,assets=[];const list=$('#assets');async function load(reset=true){if(reset){next=0;assets=[];list.replaceChildren()}const data=await api('/api/assets?offset='+next);assets.push(...data.assets);next=data.nextOffset;for(const a of data.assets){const card=document.createElement('article'),title=document.createElement('h2'),desc=document.createElement('p'),by=document.createElement('small'),actions=document.createElement('div'),view=document.createElement('button');title.textContent=a.name;desc.textContent=a.description||'';by.textContent='Published by '+a.author.displayName;actions.className='card-actions';view.textContent='Preview';view.onclick=async()=>{const detail=await api('/api/assets/'+encodeURIComponent(a.id)),entrypoint=detail.asset.entrypoint,preview=document.getElementById('preview');if(preview&&entrypoint)preview.setAttribute('src','/preview/assets/'+encodeURIComponent(a.id)+'/'+entrypoint.split('/').map(encodeURIComponent).join('/'));$('#viewer').hidden=false};actions.append(view);card.append(title,desc,by,actions);if(window.role==='publisher'){const expiry=document.createElement('input'),setExpiry=document.createElement('button'),del=document.createElement('button');expiry.type='datetime-local';expiry.setAttribute('aria-label','Hard expiry for '+a.name);setExpiry.textContent='Set expiry';setExpiry.onclick=async()=>{await mutate('/api/assets/'+a.id+'/expiry',{method:'PATCH',body:JSON.stringify({hardExpiresAt:expiry.value?new Date(expiry.value).toISOString():null})});setExpiry.textContent='Expiry saved'};del.textContent='Delete';del.onclick=async()=>{if(confirm('Delete this publication?')){await mutate('/api/assets/'+a.id,{method:'DELETE'});load()}};actions.append(expiry,setExpiry,del)}list.append(card)}$('#more').hidden=next===null}
async function mutate(url,opts){opts.headers={...(opts.headers||{}),'X-Shlook-CSRF':await csrf()};return api(url,opts)}
 if($('#archive')){api('/api/me').then(me=>{window.role=me.role;$('#identity').textContent=me.user.displayName+' · '+me.role;$('#upload-panel').hidden=me.role!=='publisher';load()}).catch(()=>location.replace('/login?return=%2Farchive'));$('#search').oninput=()=>{const q=$('#search').value.toLowerCase();for(const card of list.children)card.hidden=!card.textContent.toLowerCase().includes(q)};$('#more').onclick=()=>load(false);$('#logout').onclick=async()=>{await mutate('/api/session',{method:'DELETE'});location.replace('/login')};$('#close-preview').onclick=()=>{$('#viewer').hidden=true;document.getElementById('preview')?.removeAttribute('src')};
 const form=$('#upload');form.onsubmit=async e=>{e.preventDefault();const status=$('#upload-status');try{
 const formData=new FormData(form),files=formData.getAll('files').filter(x=>x instanceof File&&x.name),name=formData.get('name'),description=formData.get('description'),maxFile=25*1024*1024,maxTotal=100*1024*1024,maxFiles=500;
 if(!files.length)throw Error('Choose one or more files');if(files.length>maxFiles)throw Error('A publication can contain at most 500 files');if(files.some(file=>file.size>maxFile))throw Error('A file exceeds 25 MiB');let total=files.reduce((sum,file)=>sum+file.size,0);if(total>maxTotal)throw Error('A publication exceeds 100 MiB');
 const prepared=new Map(),single=files.length===1&&!files[0].webkitRelativePath,only=files[0],extension=only.name.split('.').at(-1).toLowerCase();
 if(single&&extension==='mdx')throw Error('Single-file MDX is unsupported');
 if(single&&extension==='md'){let source;try{source=new TextDecoder('utf-8',{fatal:true}).decode(await only.arrayBuffer())}catch{throw Error('Markdown must contain valid UTF-8')}const html=new TextEncoder().encode('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body><main>'+window.renderSafeMarkdown(source)+'</main></body></html>');if(html.byteLength>maxFile)throw Error('Generated Markdown HTML exceeds 25 MiB');total=total-only.size+html.byteLength;if(total>maxTotal)throw Error('A publication exceeds 100 MiB after Markdown conversion');prepared.set(only,{path:only.name+'.html',bytes:html})}
 else if(single&&['png','jpg','jpeg','gif','webp','avif'].includes(extension)){const html=new TextEncoder().encode('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body><img alt="'+escape(only.name)+'" src="'+escape(encodeURIComponent(only.name))+'"></body></html>');if(html.byteLength>maxFile||total+html.byteLength>maxTotal)throw Error('Generated image preview exceeds publication limits');const wrapped=new File([html],'index.html',{type:'text/html'});files.push(wrapped);prepared.set(wrapped,{path:'index.html',bytes:html});total+=html.byteLength}
 if(!(single&&extension==='md')&&files.every(file=>/\.(?:md|mdx)$/i.test(file.webkitRelativePath||file.name))){if(files.length>=maxFiles)throw Error('A publication can contain at most 500 files including its inert-file index');const html=new TextEncoder().encode('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body><p>Files in this directory are preserved as inert downloads; directory Markdown is not rendered.</p></body></html>');if(html.byteLength>maxFile||total+html.byteLength>maxTotal)throw Error('Generated index exceeds publication limits');const index=new File([html],'index.html',{type:'text/html'});files.push(index);prepared.set(index,{path:'index.html',bytes:html});total+=html.byteLength}
 if(total>maxTotal)throw Error('A publication exceeds 100 MiB');const asset=(await mutate('/api/assets',{method:'POST',body:JSON.stringify({name,description:description||null,visibility:'private'})})).asset,manifest=[];
 for(const file of files){const item=prepared.get(file),path=item?.path||file.webkitRelativePath||file.name,content=item?.bytes||new Uint8Array(await file.arrayBuffer());if(content.byteLength>maxFile)throw Error('A file exceeds 25 MiB');const u=await mutate('/api/assets/'+asset.id+'/files/'+path.split('/').map(encodeURIComponent).join('/'),{method:'PUT',body:content,headers:{'Content-Type':'application/octet-stream'}});manifest.push({path,uploadId:u.file.uploadId})}
  const entry=manifest.find(x=>/^(index|default)\.html?$/i.test(x.path.split('/').at(-1)))||manifest.find(x=>/\.html?$/i.test(x.path))||manifest.find(x=>! /\.(?:md|mdx|svg)$/i.test(x.path))||manifest[0];await mutate('/api/assets/'+asset.id+'/finalize',{method:'POST',body:JSON.stringify({entrypoint:entry.path,files:manifest})});status.textContent='Published successfully';form.reset();load()
  }catch(err){status.textContent='Upload failed: '+err.message}}}
})();`;
const appScript = `window.renderSafeMarkdown=${renderSafeMarkdown.toString()};\n${script}`;

export type NativeUiContext = {
  user: { id: string; displayName: string };
  role: "viewer" | "publisher";
};
export function createNativeUiHandler() {
  const serve = (response: ServerResponse, type: string, body: string) => {
    headers(response, type);
    response.statusCode = 200;
    response.end(body);
  };
  const loginHandler = (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/login", "http://native.invalid");
    if (url.pathname === "/ui/app.js")
      return serve(response, "text/javascript; charset=utf-8", appScript);
    if (url.pathname === "/ui/style.css") return serve(response, "text/css; charset=utf-8", styles);
    const value = url.searchParams.get("return");
    const returnPath = value === "/archive" ? "/archive" : "/";
    serve(
      response,
      "text/html; charset=utf-8",
      shell(
        "Sign in",
        `<header><p class="eyebrow">PRIVATE LIBRARY</p><h1>Sign in</h1><p>Your API token is exchanged for a secure browser session and is never saved.</p></header><form id="login"><label>API token<input id="token" type="password" autocomplete="off" required></label><button>Sign in</button><p id="message" role="status"></p><input type="hidden" name="return" value="${returnPath}"></form>`,
      ),
    );
  };
  const ownerHandler = (
    request: IncomingMessage,
    response: ServerResponse,
    context: NativeUiContext,
  ) => {
    const path = new URL(request.url ?? "/", "http://native.invalid").pathname;
    if (path === "/ui/app.js") return serve(response, "text/javascript; charset=utf-8", appScript);
    if (path === "/ui/style.css") return serve(response, "text/css; charset=utf-8", styles);
    serve(
      response,
      "text/html; charset=utf-8",
      shell(
        "Archive",
        `<header class="mast"><div><p class="eyebrow">SHLOOK · PRIVATE LIBRARY</p><h1>Archive</h1><p id="identity">${escapeHtml(context.user.displayName)} · ${context.role}</p></div><button id="logout" class="quiet">Log out</button></header><section class="toolbar"><label class="search">Search publications<input id="search" type="search" placeholder="Name, description, author"></label><a href="/login">Session details</a></section><section id="assets" aria-live="polite"></section><button id="more" hidden>Load more</button><section id="upload-panel" hidden><h2>Publish a private artifact</h2><form id="upload"><label>Name<input name="name" required maxlength="120"></label><label>Description<input name="description" maxlength="500"></label><label>Files<input name="files" type="file" multiple></label><label>Static folder<input name="files" type="file" multiple webkitdirectory></label><button>Upload and publish</button><p id="upload-status" role="status"></p></form><p class="note">Share links and public visibility are not supported by this private native library.</p></section><section id="viewer" hidden><div class="viewer-head"><h2>Preview</h2><button id="close-preview">Close</button></div><iframe id="preview" title="Sandboxed artifact preview" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe></section>`,
      ),
    );
  };
  return { loginHandler, ownerHandler };
}

const styles = `:root{color-scheme:light;--ink:#17211d;--muted:#66746c;--line:#dce3dd;--paper:#f5f7f3;--accent:#176b50}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 Georgia,serif}main{max-width:920px;margin:0 auto;padding:clamp(24px,6vw,72px) 24px}h1{font-size:clamp(2.5rem,8vw,4.6rem);line-height:1;margin:.2em 0}h2{font-size:1.35rem;margin:.4em 0}p{color:var(--muted)}header{border-bottom:1px solid var(--line);padding:0 0 28px}.eyebrow{letter-spacing:.18em;font:700 .72rem/1.4 ui-monospace,monospace;color:var(--accent)}button,a{font:600 .95rem/1.2 ui-sans-serif,system-ui}button{background:var(--accent);border:0;border-radius:3px;color:white;padding:12px 18px;cursor:pointer}button:hover{filter:brightness(.9)}button:disabled{opacity:.5}.quiet{background:transparent;color:var(--accent);border:1px solid var(--line)}label{display:grid;gap:8px;font-weight:600;margin:18px 0}input{font:inherit;border:1px solid var(--line);border-radius:3px;padding:12px;background:white;color:var(--ink)}form{max-width:620px}#assets{display:grid;gap:12px;margin:30px 0}article{background:white;border:1px solid var(--line);padding:20px;display:grid;grid-template-columns:1fr auto;gap:5px 18px}article h2,article p,article small{grid-column:1}.card-actions{grid-column:2;grid-row:1;display:flex;gap:8px;align-items:start}.toolbar,.mast,.viewer-head{display:flex;align-items:center;justify-content:space-between;gap:18px}.toolbar{padding:14px 0}.toolbar a{color:var(--accent)}.search{display:flex;align-items:center;gap:12px;margin:0}.search input{width:min(48vw,360px)}#upload-panel{border-top:1px solid var(--line);padding-top:24px}.note{font-size:.9rem}#viewer{position:fixed;inset:4vh 4vw;background:white;border:1px solid var(--line);box-shadow:0 20px 80px #17211d55;padding:14px;z-index:3}#viewer iframe{border:1px solid var(--line);width:100%;height:calc(100% - 55px)}[hidden]{display:none!important}@media(max-width:600px){article{grid-template-columns:1fr}.card-actions{grid-column:1;grid-row:auto;flex-wrap:wrap}.toolbar,.mast{align-items:flex-start;flex-direction:column}.search{display:grid}.search input{width:100%}}`;
