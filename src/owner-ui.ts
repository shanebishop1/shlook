interface OwnerAsset {
  id: string;
  visibility: "private" | "secret_link" | "public";
  has_secret: number;
  share_expires_at: string | null;
  hard_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

const pageSize = 24;

function escapeHtml(value: string): string {
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

function assetCard(asset: OwnerAsset, latest: boolean, privateOrigin: string): string {
  const id = escapeHtml(asset.id);
  const privateUrl = `${privateOrigin}/assets/${id}/`;
  const secretAction = asset.has_secret === 1 ? "rotate" : "create";
  const visibilityOptions = ["private", "secret_link", "public"]
    .map(
      (visibility) =>
        `<option value="${visibility}"${asset.visibility === visibility ? " selected" : ""}>${visibility.replace("_", " ")}</option>`,
    )
    .join("");

  return `<article class="asset-card${latest ? " latest-card" : ""}" data-id="${id}">
    <div class="card-rule"><span>${latest ? "Latest transmission" : "Artifact"}</span><time datetime="${escapeHtml(asset.created_at)}">${escapeHtml(asset.created_at.slice(0, 10))}</time></div>
    <h2>${id.slice(0, 8)}<span>/${id.slice(9, 13)}</span></h2>
    <a class="view-link" href="${privateUrl}">Open private view <b aria-hidden="true">↗</b></a>
    <dl>
      <div><dt>Visibility</dt><dd>${escapeHtml(asset.visibility.replace("_", " "))}</dd></div>
      <div><dt>Updated</dt><dd>${escapeHtml(asset.updated_at.slice(0, 16).replace("T", " "))}Z</dd></div>
    </dl>
    <div class="controls">
      <label>Exposure<select data-visibility>${visibilityOptions}</select></label>
      <div class="button-row">
        <button type="button" data-secret="${secretAction}">${secretAction === "create" ? "Issue secret link" : "Rotate secret"}</button>
        <button type="button" class="quiet" data-secret="revoke"${asset.has_secret === 1 ? "" : " hidden"}>Revoke secret</button>
      </div>
      <div class="expiry-grid">
        <label>Share expires<input data-share-expiry data-iso="${escapeHtml(asset.share_expires_at ?? "")}" type="datetime-local"></label>
        <label>Hard expires<input data-hard-expiry data-iso="${escapeHtml(asset.hard_expires_at ?? "")}" type="datetime-local"></label>
      </div>
      <div class="button-row end-row">
        <button type="button" class="quiet" data-expiry>Apply expiries</button>
        <button type="button" class="danger" data-delete>Delete</button>
      </div>
    </div>
    <p class="card-status" role="status" aria-live="polite"></p>
  </article>`;
}

function script(): string {
  return `const setStatus=(card,message,error=false)=>{const node=card.querySelector('.card-status');node.textContent=message;node.classList.toggle('error',error)};
const mutate=async(card,path,init)=>{setStatus(card,'Working...');const response=await fetch('/api/assets/'+card.dataset.id+path,{...init,headers:{'content-type':'application/json',...(init.headers||{})}});let body={};try{body=await response.json()}catch{}if(!response.ok)throw new Error(body.error||('Request failed: '+response.status));return body};
document.querySelectorAll('input[data-iso]').forEach(input=>{if(!input.dataset.iso)return;const date=new Date(input.dataset.iso);const local=new Date(date.getTime()-date.getTimezoneOffset()*60000);input.value=local.toISOString().slice(0,16)});
document.addEventListener('change',async event=>{if(!event.target.matches('[data-visibility]'))return;const card=event.target.closest('.asset-card');try{await mutate(card,'/visibility',{method:'PATCH',body:JSON.stringify({visibility:event.target.value})});setStatus(card,'Visibility updated.');setTimeout(()=>location.reload(),350)}catch(error){setStatus(card,error.message,true)}});
document.addEventListener('click',async event=>{const button=event.target.closest('button');if(!button)return;const card=button.closest('.asset-card');try{if(button.dataset.secret){const action=button.dataset.secret;if(action==='revoke'){await mutate(card,'/secret',{method:'DELETE'});setStatus(card,'Secret revoked.');setTimeout(()=>location.reload(),350)}else{const body=await mutate(card,'/secret?mode='+action,{method:'POST',body:'{}'});let copied=false;try{await navigator.clipboard.writeText(body.url);copied=true}catch{}setStatus(card,(copied?'Secret URL copied: ':'Secret URL: ')+body.url);button.dataset.secret='rotate';button.textContent='Rotate secret';card.querySelector('[data-secret="revoke"]').hidden=false}}else if(button.hasAttribute('data-expiry')){const value=input=>input.value?new Date(input.value).toISOString():null;const hard=value(card.querySelector('[data-hard-expiry]'));if(hard&&!confirm('Hard expiry permanently deletes this artifact at the selected time. Apply it?'))return;await mutate(card,'/expiry',{method:'PATCH',body:JSON.stringify({shareExpiresAt:value(card.querySelector('[data-share-expiry]')),hardExpiresAt:hard})});setStatus(card,'Expiry policy updated.');setTimeout(()=>location.reload(),500)}else if(button.hasAttribute('data-delete')){if(!confirm('Permanently delete this artifact?'))return;await mutate(card,'',{method:'DELETE'});location.reload()}}catch(error){setStatus(card,error.message,true)}});`;
}

function styles(): string {
  return `:root{color-scheme:light;--paper:#efe8d8;--ink:#1d211d;--muted:#6a695f;--line:#aca58f;--signal:#da3a1b;--panel:#f8f2e5}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:"Iowan Old Style","Palatino Linotype",Palatino,serif}body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.2;background-image:repeating-linear-gradient(0deg,transparent 0 4px,#786f5c12 5px)}header,main,footer{width:min(1180px,calc(100% - 40px));margin-inline:auto}header{display:grid;grid-template-columns:1fr auto;align-items:end;padding:42px 0 25px;border-bottom:3px solid var(--ink)}.kicker,.card-rule,dt,label,button,.folio{font:700 11px/1.25 ui-monospace,"Cascadia Mono",monospace;letter-spacing:.12em;text-transform:uppercase}.kicker{color:var(--signal);margin:0 0 7px}h1{font-size:clamp(46px,9vw,104px);font-weight:500;line-height:.75;letter-spacing:-.07em;margin:0}header aside{text-align:right;border-left:1px solid var(--line);padding-left:24px;color:var(--muted)}header aside b{display:block;font:700 14px ui-monospace,monospace;color:var(--ink);margin-top:6px}.intro{display:flex;justify-content:flex-end;padding:28px 0}.latest-label{text-align:right;color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.asset-card{position:relative;background:var(--panel);border:1px solid var(--ink);padding:22px;box-shadow:5px 5px 0 #1d211d14;animation:arrive .45s both}.asset-card:nth-child(2n){animation-delay:.08s}.latest-card{grid-column:1/-1;border-top:7px solid var(--signal);padding:clamp(24px,4vw,48px)}.card-rule{display:flex;justify-content:space-between;color:var(--muted);border-bottom:1px solid var(--line);padding-bottom:8px}.card-rule span{color:var(--signal)}h2{font-size:clamp(30px,5vw,65px);font-weight:400;letter-spacing:-.045em;margin:22px 0 4px}h2 span{color:var(--muted)}.view-link{display:inline-block;color:var(--ink);font-style:italic;font-size:17px;text-decoration-thickness:1px;text-underline-offset:5px;margin-bottom:24px}.view-link b{color:var(--signal)}dl{display:flex;gap:28px;margin:0 0 20px}dl div{border-left:2px solid var(--line);padding-left:10px}dt{color:var(--muted)}dd{margin:4px 0 0;font-size:14px}.controls{border-top:1px solid var(--line);padding-top:18px;display:grid;gap:13px}label{display:grid;gap:6px;color:var(--muted)}select,input,button{border:1px solid var(--ink);border-radius:0;background:#fffaf0;color:var(--ink);padding:11px 12px;font:600 13px ui-monospace,"Cascadia Mono",monospace}button{cursor:pointer;background:var(--ink);color:var(--paper);transition:transform .15s,background .15s}button:hover{transform:translateY(-2px);background:var(--signal)}button.quiet{background:transparent;color:var(--ink)}button.danger{background:transparent;color:var(--signal);border-color:var(--signal)}.button-row,.expiry-grid{display:flex;gap:10px}.expiry-grid label{flex:1}.end-row{justify-content:space-between}.card-status{min-height:19px;margin:10px 0 0;color:#266340;font:600 12px ui-monospace,monospace;overflow-wrap:anywhere}.card-status.error{color:var(--signal)}.empty{grid-column:1/-1;padding:80px 20px;border-block:1px solid var(--line);text-align:center;font-size:24px}.pagination{display:flex;justify-content:space-between;padding:28px 0}.pagination a{color:var(--ink);font:700 12px ui-monospace,monospace;text-transform:uppercase}footer{display:flex;justify-content:space-between;padding:30px 0 45px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}@keyframes arrive{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}@media(max-width:700px){header{grid-template-columns:1fr;padding-top:28px}header aside{display:none}.latest-label{text-align:left}.grid{grid-template-columns:1fr}.latest-card{grid-column:auto}.asset-card,.latest-card{padding:20px}h2{font-size:34px}.button-row,.expiry-grid{flex-direction:column}.end-row{align-items:stretch}dl{display:grid;gap:10px}footer{display:grid;gap:8px}}@media(prefers-reduced-motion:reduce){.asset-card{animation:none}button{transition:none}}`;
}

export async function ownerPage(
  request: Request,
  db: D1Database,
  privateOrigin: string,
): Promise<Response> {
  const url = new URL(request.url);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return Response.json({ error: "invalid_offset" }, { status: 400 });
  }
  const { results } = await db
    .prepare(
      "SELECT id, visibility, secret_hash IS NOT NULL AS has_secret, share_expires_at, " +
        "hard_expires_at, created_at, updated_at FROM assets WHERE state = 'live' AND " +
        "(hard_expires_at IS NULL OR hard_expires_at > ?) " +
        "ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
    )
    .bind(new Date().toISOString(), pageSize + 1, offset)
    .all<OwnerAsset>();
  const assets = results.slice(0, pageSize);
  const nonceBytes = crypto.getRandomValues(new Uint8Array(18));
  const nonce = btoa(String.fromCharCode(...nonceBytes));
  const cards = assets
    .map((asset, index) => assetCard(asset, offset === 0 && index === 0, privateOrigin))
    .join("");
  const previous =
    offset > 0
      ? `<a href="/?offset=${Math.max(0, offset - pageSize)}">← Newer</a>`
      : "<span></span>";
  const next =
    results.length > pageSize
      ? `<a href="/?offset=${offset + pageSize}">Older →</a>`
      : "<span></span>";
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>shlook / owner archive</title><style nonce="${nonce}">${styles()}</style></head><body>
  <header><h1>shlook</h1><aside>Owner archive<b>${assets.length} on this folio</b></aside></header>
  <main><section class="intro"><div class="latest-label kicker">Folio ${Math.floor(offset / pageSize) + 1}<br>${new Date().toISOString().slice(0, 10)}</div></section>
  <section class="grid" aria-label="Artifact archive">${cards || '<div class="empty">No live artifacts in the ledger.</div>'}</section><nav class="pagination" aria-label="Archive pages">${previous}${next}</nav></main>
  <footer><span>Access protected / storage private</span><span class="folio">${escapeHtml(url.hostname)}</span></footer><script nonce="${nonce}">${script()}</script></body></html>`;
  return new Response(body, {
    headers: {
      "cache-control": "private, no-store",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}
