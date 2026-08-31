import { hashSecret } from "./privacy";
import { decryptSecret } from "./secret-crypto";

interface OwnerAsset {
  id: string;
  name: string;
  description: string | null;
  visibility: "private" | "secret_link" | "public";
  has_secret: number;
  secret_url: string | null;
  share_expires_at: string | null;
  hard_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface OwnerAssetRow extends Omit<OwnerAsset, "has_secret" | "secret_url"> {
  secret_hash: string | null;
  secret_ciphertext: string | null;
  secret_iv: string | null;
}

const pageSize = 24;
const foldedSignalPaths =
  '<path class="brand-ribbon" d="M22 29 106 11v31L52 54l54 14v31l-84 19V87l54-13-54-14z"/>' +
  '<path class="brand-fold" d="m52 54 54-12-30 32-54-14z"/>';

function brandMark(): string {
  return `<svg class="brand-mark" viewBox="0 0 128 128" aria-hidden="true">${foldedSignalPaths}</svg>`;
}

export function ownerFavicon(): Response {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="shlook"><rect width="128" height="128" rx="22" fill="#0c0f0d"/><path d="M22 29 106 11v31L52 54l54 14v31l-84 19V87l54-13-54-14z" fill="#d6a36f"/><path d="m52 54 54-12-30 32-54-14z" fill="#4c9874"/></svg>`;
  return new Response(svg, {
    headers: {
      "cache-control": "public, max-age=86400",
      "content-security-policy": "default-src 'none'; sandbox",
      "content-type": "image/svg+xml; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

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
  return `<div class="preview-media"><img class="preview-image" data-preview-image src="${previewUrl}" alt="${size} of ${label}" loading="lazy" referrerpolicy="no-referrer"><iframe class="preview-frame" data-preview-fallback data-src="${previewUrl}" title="${size} of ${label}" sandbox="allow-scripts" scrolling="no" loading="lazy" referrerpolicy="no-referrer" tabindex="-1" hidden></iframe></div>`;
}

function visibilityLabel(value: string): string {
  return value.replace("_", " ").replace(/^./, (character) => character.toUpperCase());
}

function copyIcon(): string {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>';
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

function assetRows(
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
    <td class="preview-cell"><button class="preview-button" type="button" data-inspect aria-label="Inspect ${name}">${previewMedia(previewUrl, asset.name)}</button></td>
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
        <div class="danger-line"><span>Deletion is permanent.</span><button class="button danger" type="button" data-request-delete>Delete artifact</button></div>
        <div class="confirm" data-confirm hidden><p>Delete ${name}? This cannot be undone.</p><div class="button-row"><button class="button danger" type="button" data-delete>Delete permanently</button><button class="button" type="button" data-cancel-delete>Cancel</button></div></div>
       </div>
    </div></td>
  </tr>`;
}

function script(): string {
  return `const records=[...document.querySelectorAll('[data-record]')];
const count=document.querySelector('[data-count]');
const empty=document.querySelector('[data-empty]');
const toast=document.querySelector('[data-toast]');
const filterMenu=document.querySelector('[data-filter-menu]');
let toastTimer;
const labels={private:'Private',secret_link:'Secret link',public:'Public'};
const errorMessage=code=>code==='not_found'?'Artifact no longer exists. Refreshing...':code==='secret_required'?'Issue a secret link before selecting Secret link.':code==='asset_not_live'?'This artifact is no longer active.':code==='secret_encryption_unavailable'?'Secret-link encryption is not configured.':code.replaceAll('_',' ');
const setStatus=(_card,message,error=false)=>{if(message.startsWith('Secret URL'))message=message.startsWith('Secret URL copied')?'Secret link copied.':'Secret link ready.';toast.textContent=message;toast.classList.toggle('error',error);toast.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.classList.remove('show'),error?4000:2400)};
const reportError=(card,error)=>{setStatus(card,error.message,true);if(error.code==='not_found')setTimeout(()=>location.reload(),900)};
const mutate=async(card,path,init)=>{setStatus(card,'Working...');const response=await fetch('/api/assets/'+card.dataset.detail+path,{...init,headers:{'content-type':'application/json',...(init.headers||{})}});let body={};try{body=await response.json()}catch{}if(!response.ok){const code=body.error||('request_failed_'+response.status);const failure=new Error(errorMessage(code));failure.code=code;throw failure}if(typeof body.url==='string')card.dataset.secretUrl=body.url;if(path==='/secret'&&init.method==='DELETE')card.dataset.secretUrl='';return body};
const cardForId=id=>document.querySelector('[data-detail="'+id+'"]');
const fitPreviewFrame=frame=>{const media=frame.parentElement;const renderWidth=1280;const load=()=>{if(frame.hasAttribute('src')||frame.dataset.loading)return;frame.dataset.loading='1';requestAnimationFrame(()=>{delete frame.dataset.loading;if(media.clientWidth<=0||media.clientHeight<=0||frame.clientWidth!==renderWidth)return;frame.src=frame.dataset.src})};const resize=()=>{const scale=media.clientWidth/renderWidth;if(scale<=0||media.clientHeight<=0)return;frame.style.width=renderWidth+'px';frame.style.height=Math.ceil(media.clientHeight/scale)+'px';frame.style.transform='scale('+scale+')';load()};new ResizeObserver(resize).observe(media);requestAnimationFrame(resize)};
const showPreviewFallback=image=>{const frame=image.parentElement.querySelector('[data-preview-fallback]');if(!frame.hidden)return;image.hidden=true;frame.hidden=false;fitPreviewFrame(frame)};
document.querySelectorAll('[data-preview-image]').forEach(image=>{image.addEventListener('error',()=>showPreviewFallback(image),{once:true});if(image.complete&&image.naturalWidth===0)showPreviewFallback(image)});
const closeMenus=except=>{document.querySelectorAll('[data-menu-list]:not([hidden])').forEach(list=>{if(list===except)return;list.hidden=true;list.parentElement.querySelector('[data-menu-button]').setAttribute('aria-expanded','false')})};
const toggleMenu=menu=>{const list=menu.querySelector('[data-menu-list]');const open=list.hidden;closeMenus(open?list:null);list.hidden=!open;menu.querySelector('[data-menu-button]').setAttribute('aria-expanded',String(open));if(open){const selected=list.querySelector('[aria-selected="true"]:not(:disabled)')||list.querySelector('[role="option"]:not(:disabled)');selected?.focus()}};
const setMenuValue=(menu,value)=>{menu.dataset.value=value;menu.querySelector('[data-menu-label]').textContent=value==='all'?'All visibility':labels[value];menu.querySelectorAll('[role="option"]').forEach(option=>option.setAttribute('aria-selected',String((option.dataset.visibilityOption||option.dataset.filterOption)===value)))};
const filterRecords=()=>{const query=document.querySelector('[data-search]').value.trim().toLowerCase();const visibility=filterMenu.dataset.value;let visible=0;for(const row of records){const match=(!query||row.dataset.search.includes(query))&&(visibility==='all'||row.dataset.visibility===visibility);row.hidden=!match;const detail=cardForId(row.dataset.record);if(!match)detail.hidden=true;else if(row.classList.contains('is-open'))detail.hidden=false;if(match)visible++}count.textContent=visible+' '+(visible===1?'artifact':'artifacts');empty.hidden=visible!==0};
const shareUrlFor=(card,value)=>value==='public'?card.dataset.publicUrl:value==='secret_link'?card.dataset.secretUrl:'';
const syncShare=(row,card,value)=>{const url=shareUrlFor(card,value);card.querySelector('.share-url').textContent=url||(value==='secret_link'?'Rotate once to recover this existing secret link':'Available when this artifact is public');card.querySelector('[data-copy-public]').disabled=!url;const rowCopy=row.querySelector('[data-copy-row]');rowCopy.hidden=value==='private';rowCopy.disabled=!url};
const syncVisibility=(id,value)=>{const row=document.querySelector('[data-record="'+id+'"]');const card=cardForId(id);row.dataset.visibility=value;row.dataset.search=row.dataset.searchText+' '+value;document.querySelectorAll('[data-visibility-menu][data-asset-id="'+id+'"]').forEach(menu=>setMenuValue(menu,value));syncShare(row,card,value);filterRecords()};
const toggle=(row)=>{const detail=cardForId(row.dataset.record);const open=!row.classList.contains('is-open');for(const other of records){if(other===row)continue;other.classList.remove('is-open');other.setAttribute('aria-selected','false');other.querySelector('[data-inspect][aria-expanded]').setAttribute('aria-expanded','false');cardForId(other.dataset.record).hidden=true}row.classList.toggle('is-open',open);row.setAttribute('aria-selected',String(open));row.querySelector('[data-inspect][aria-expanded]').setAttribute('aria-expanded',String(open));detail.hidden=!open;if(open&&innerWidth<901)row.scrollIntoView({behavior:'smooth',block:'start'})};
const setTheme=theme=>{document.documentElement.dataset.theme=theme;const dark=theme==='dark';document.querySelector('[data-theme-toggle]').setAttribute('aria-label',dark?'Switch to light mode':'Switch to dark mode');try{localStorage.setItem('shlook-theme',theme)}catch{}};
let initialTheme=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';try{initialTheme=localStorage.getItem('shlook-theme')||initialTheme}catch{}setTheme(initialTheme);
document.querySelector('[data-theme-toggle]').addEventListener('click',()=>setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark'));
document.querySelectorAll('input[data-iso]').forEach(input=>{if(!input.dataset.iso)return;const date=new Date(input.dataset.iso);const local=new Date(date.getTime()-date.getTimezoneOffset()*60000);input.value=local.toISOString().slice(0,16)});
const localDate=new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',year:'numeric'});
const localTime=new Intl.DateTimeFormat(undefined,{hour:'2-digit',minute:'2-digit',timeZoneName:'short'});
document.querySelectorAll('[data-local-time]').forEach(element=>{const date=new Date(element.dateTime);if(Number.isNaN(date.getTime()))return;const zone=document.createElement('span');zone.className='meta-sub';zone.textContent=localTime.format(date);element.textContent=localDate.format(date);element.append(zone)});
document.querySelector('[data-search]').addEventListener('input',filterRecords);
document.addEventListener('keydown',event=>{const menu=event.target.closest?.('.custom-select');if(event.key==='Escape'){closeMenus();menu?.querySelector('[data-menu-button]')?.focus();return}if(!menu||!['ArrowDown','ArrowUp'].includes(event.key))return;event.preventDefault();const options=[...menu.querySelectorAll('[role="option"]:not(:disabled)')];const index=options.indexOf(document.activeElement);options[(index+(event.key==='ArrowDown'?1:-1)+options.length)%options.length]?.focus()});
document.addEventListener('click',async event=>{const copy=event.target.closest('[data-copy-row],[data-copy-public]');if(!copy)return;event.preventDefault();event.stopImmediatePropagation();const row=copy.closest('[data-record]')||document.querySelector('[data-record="'+copy.closest('[data-detail]').dataset.detail+'"]');const card=cardForId(row.dataset.record);const url=shareUrlFor(card,row.dataset.visibility);if(!url)return;try{await navigator.clipboard.writeText(url);setStatus(card,'Share link copied.')}catch(error){reportError(card,error)}},true);
document.addEventListener('click',async event=>{const menuButton=event.target.closest('[data-menu-button]');if(menuButton){toggleMenu(menuButton.closest('.custom-select'));return}const filterOption=event.target.closest('[data-filter-option]');if(filterOption){setMenuValue(filterMenu,filterOption.dataset.filterOption);closeMenus();filterRecords();return}const visibilityOption=event.target.closest('[data-visibility-option]');if(visibilityOption){const menu=visibilityOption.closest('[data-visibility-menu]');const id=menu.dataset.assetId;const row=document.querySelector('[data-record="'+id+'"]');const card=cardForId(id);const previous=row.dataset.visibility;const value=visibilityOption.dataset.visibilityOption;const needsSecret=value==='secret_link'&&card.dataset.hasSecret!=='1';const path=needsSecret?'/secret?mode=create':'/visibility';const init=needsSecret?{method:'POST',body:'{}'}:{method:'PATCH',body:JSON.stringify({visibility:value})};closeMenus();syncVisibility(id,value);menu.querySelector('[data-menu-button]').disabled=true;try{await mutate(card,path,init);if(needsSecret){card.dataset.hasSecret='1';const secretButton=card.querySelector('[data-secret="create"]');secretButton.dataset.secret='rotate';secretButton.textContent='Rotate secret link';card.querySelector('[data-secret="revoke"]').hidden=false;syncVisibility(id,value)}setStatus(card,'Visibility updated.')}catch(error){syncVisibility(id,previous);reportError(card,error)}finally{menu.querySelector('[data-menu-button]').disabled=false}return}const inspect=event.target.closest('[data-inspect]');if(inspect){toggle(inspect.closest('[data-record]'));return}const row=event.target.closest('[data-record]');if(row&&!event.target.closest('a,button,input')){closeMenus();toggle(row);return}const button=event.target.closest('button');if(!button){closeMenus();return}const card=button.closest('[data-detail]');if(!card)return;button.disabled=true;try{if(button.dataset.secret){const action=button.dataset.secret;if(action==='revoke'){const current=document.querySelector('[data-record="'+card.dataset.detail+'"]').dataset.visibility;await mutate(card,'/secret',{method:'DELETE'});card.dataset.hasSecret='0';syncVisibility(card.dataset.detail,current==='secret_link'?'private':current);setStatus(card,'Secret revoked.');button.hidden=true;card.querySelector('[data-secret="rotate"]').dataset.secret='create';card.querySelector('[data-secret="create"]').textContent='Issue secret link'}else{const body=await mutate(card,'/secret?mode='+action,{method:'POST',body:'{}'});card.dataset.hasSecret='1';syncVisibility(card.dataset.detail,'secret_link');let copied=false;try{await navigator.clipboard.writeText(body.url);copied=true}catch{}setStatus(card,(copied?'Secret URL copied. ':'Secret URL: ')+body.url);button.dataset.secret='rotate';button.textContent='Rotate secret link';card.querySelector('[data-secret="revoke"]').hidden=false}}else if(button.hasAttribute('data-expiry')){const value=input=>input.value?new Date(input.value).toISOString():null;const hard=value(card.querySelector('[data-hard-expiry]'));if(hard&&!confirm('Artifact expiration permanently deletes this artifact at the selected time. Apply it?'))return;await mutate(card,'/expiry',{method:'PATCH',body:JSON.stringify({shareExpiresAt:value(card.querySelector('[data-share-expiry]')),hardExpiresAt:hard})});setStatus(card,'Expiration policy updated.');setTimeout(()=>location.reload(),500)}else if(button.hasAttribute('data-clear-expiry')){await mutate(card,'/expiry',{method:'PATCH',body:JSON.stringify({shareExpiresAt:null,hardExpiresAt:null})});setStatus(card,'Expirations cleared.');setTimeout(()=>location.reload(),350)}else if(button.hasAttribute('data-copy-public')){await navigator.clipboard.writeText(card.dataset.publicUrl);setStatus(card,'Share link copied.')}else if(button.hasAttribute('data-request-delete')){const confirmation=card.querySelector('[data-confirm]');confirmation.hidden=false;confirmation.querySelector('[data-delete]').focus()}else if(button.hasAttribute('data-cancel-delete')){card.querySelector('[data-confirm]').hidden=true;card.querySelector('[data-request-delete]').focus()}else if(button.hasAttribute('data-delete')){await mutate(card,'',{method:'DELETE'});location.reload()}}catch(error){reportError(card,error)}finally{if(document.contains(button))button.disabled=false}});
filterRecords();`;
}

function styles(): string {
  return `:root{color-scheme:light;--ink:#17201d;--muted:#65706b;--faint:#f4f6f5;--line:#d9dfdc;--line-strong:#bdc6c2;--accent:#165d4a;--danger:#9f302f;--danger-soft:#fff1f0;--paper:#fbfcfb;--white:#fff;--shadow:0 12px 32px #1b2b2514}*{box-sizing:border-box}html{font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{margin:0;background:var(--paper);color:var(--ink);font-size:14px;line-height:1.45;-webkit-font-smoothing:antialiased}button,input,select{font:inherit}button,select{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.48}:focus-visible{outline:3px solid #4e9b85;outline-offset:2px}.shell{width:min(1280px,calc(100% - 48px));margin:0 auto}.masthead{min-height:72px;border-bottom:1px solid var(--line);background:var(--white)}.masthead .shell{min-height:72px;display:flex;align-items:center;justify-content:space-between;gap:24px}.identity{display:flex;align-items:baseline;gap:14px;white-space:nowrap}.wordmark{font-weight:750;font-size:20px;letter-spacing:-.04em}.context{color:var(--muted);font-size:13px}.owner-mark{color:var(--muted);font-size:12px;display:flex;gap:8px;align-items:center}.owner-mark:before{content:"";width:7px;height:7px;border-radius:50%;background:#33846d}main{padding:42px 0 70px}.page-heading{display:flex;align-items:end;justify-content:space-between;gap:24px;margin-bottom:24px}h1{margin:0;font-size:26px;line-height:1.15;letter-spacing:-.035em;font-weight:690}.page-heading p{margin:6px 0 0;color:var(--muted);font-size:13px}.count{color:var(--muted);font-variant-numeric:tabular-nums;font-size:13px}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:14px}.search{position:relative;width:min(380px,100%)}.search svg{position:absolute;left:12px;top:50%;width:16px;transform:translateY(-50%);color:var(--muted);pointer-events:none}.search input{width:100%;height:38px;padding:0 12px 0 38px;border:1px solid var(--line-strong);border-radius:5px;background:var(--white);color:var(--ink)}.filter-wrap{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px}.filter-wrap select{height:38px;min-width:136px;padding:0 30px 0 10px;border:1px solid var(--line-strong);border-radius:5px;background:var(--white);color:var(--ink)}.ledger{border-top:1px solid var(--line-strong);border-bottom:1px solid var(--line-strong);background:var(--white);overflow:hidden}table{width:100%;border-collapse:collapse;table-layout:fixed}th{height:40px;padding:0 14px;text-align:left;color:var(--muted);font-size:11px;font-weight:650;letter-spacing:.055em;text-transform:uppercase;border-bottom:1px solid var(--line)}th:nth-child(1){width:190px}th:nth-child(2){width:22%}th:nth-child(3){width:125px}th:nth-child(4),th:nth-child(5),th:nth-child(6){width:155px}th:nth-child(7){width:66px}.artifact-row{border-bottom:1px solid var(--line);transition:background .14s}.artifact-row:hover{background:#fafcfb}.artifact-row.is-open{background:var(--faint);border-bottom-color:transparent}.artifact-row[hidden],.detail-row[hidden]{display:none}td{height:112px;padding:13px 14px;vertical-align:middle}.preview-button{display:block;width:160px;height:88px;padding:0;border:1px solid #cbd2cf;border-radius:3px;background:#eef1f0;overflow:hidden;box-shadow:0 2px 8px #15231e14}.preview-media{position:relative;width:100%;height:100%;min-height:inherit}.preview-image,.preview-frame{display:block;width:100%;height:100%;border:0;background:#eef1f0}.preview-image{object-fit:cover}.preview-frame{pointer-events:none}.preview-image[hidden],.preview-frame[hidden]{display:none}.artifact-title{display:flex;align-items:center;gap:8px;color:var(--ink);font-size:15px;font-weight:650;letter-spacing:-.01em}.latest{padding:2px 5px;border-radius:3px;background:#e7f0ed;color:var(--accent);font-size:9px;letter-spacing:.05em;text-transform:uppercase}.artifact-id{display:block;max-width:100%;margin-top:6px;overflow:hidden;color:var(--muted);font:11px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;text-overflow:ellipsis}.meta{color:#3e4945;font-size:13px;font-variant-numeric:tabular-nums}.meta-sub{display:block;margin-top:3px;color:var(--muted);font-size:11px}.badge{display:inline-flex;align-items:center;gap:6px;color:#315148;font-size:12px;font-weight:600;text-transform:capitalize}.badge:before{content:"";width:7px;height:7px;border-radius:50%;background:#39866f}.badge.private{color:#5b625f}.badge.private:before{background:#8b9591}.badge.secret_link{color:#6c5833}.badge.secret_link:before{background:#a68243}.row-action{display:flex;justify-content:flex-end}.inspect-button{width:36px;height:36px;padding:0;border:1px solid var(--line-strong);border-radius:4px;background:var(--white);color:#34413c;display:grid;place-items:center}.inspect-button:hover{border-color:#80918a;background:var(--faint)}.inspect-button svg{width:17px;transition:transform .16s}.is-open [data-inspect][aria-expanded] svg{transform:rotate(180deg)}.detail-row{background:var(--faint)}.detail-row td{height:auto;padding:0}.inspector{margin:0 14px 18px;border:1px solid var(--line);background:var(--white);box-shadow:var(--shadow);display:grid;grid-template-columns:minmax(360px,1.35fr) minmax(390px,1fr)}.large-preview{min-height:420px;background:#e8ecea;border-right:1px solid var(--line);overflow:hidden}.large-preview .preview-media{min-height:420px}.large-preview .preview-image{object-fit:contain;padding:22px}.large-preview .preview-frame{min-height:420px}.panel{min-width:0;padding:26px}.panel-head{display:flex;align-items:start;justify-content:space-between;gap:16px;padding-bottom:20px;border-bottom:1px solid var(--line)}.panel h2{margin:0;font-size:18px;letter-spacing:-.025em}.panel-head p{max-width:250px;margin:5px 0 0;overflow:hidden;color:var(--muted);font:11px/1.3 ui-monospace,monospace;text-overflow:ellipsis}.open-link{flex:none;color:var(--accent);font-size:12px;font-weight:650;text-decoration:none}.open-link:hover{text-decoration:underline}.summary{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:16px 0 0}.summary div{min-width:0}.summary dt,.control-label,.expiry-grid label{color:var(--muted);font-size:11px;font-weight:650;letter-spacing:.045em;text-transform:uppercase}.summary dd{margin:5px 0 0}.summary .meta-sub{display:inline;margin-left:5px}.control-group{padding:18px 0;border-bottom:1px solid var(--line)}.control-label{display:block}.control-label select{display:block;width:100%;height:36px;margin-top:9px;padding:0 9px;border:1px solid var(--line-strong);border-radius:4px;background:var(--white);color:var(--ink);text-transform:capitalize}.hint{margin:9px 0 0;color:var(--muted);font-size:11px}.button-row{display:flex;align-items:center;gap:8px;margin-top:10px}.expiry-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:9px}.expiry-grid input{display:block;width:100%;min-width:0;height:36px;margin-top:7px;padding:0 9px;border:1px solid var(--line-strong);border-radius:4px;background:var(--white);color:var(--ink);font-size:12px}.button{min-height:36px;padding:0 12px;border:1px solid var(--line-strong);border-radius:4px;background:var(--white);color:#2c3934;font-size:12px;font-weight:620}.button:hover{border-color:#819089;background:var(--faint)}.button.primary{border-color:var(--accent);background:var(--accent);color:white}.button.primary:hover{background:#104d3d}.button.danger{border-color:#d7aaa7;color:var(--danger)}.button.danger:hover{background:var(--danger-soft);border-color:#c77e79}.share-line{display:flex;align-items:center;gap:8px;margin-top:9px}.share-url{flex:1;min-width:0;overflow:hidden;color:var(--muted);font:11px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;text-overflow:ellipsis;white-space:nowrap}.danger-line{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:18px}.danger-line span{color:var(--muted);font-size:11px}.confirm{margin-top:14px;padding:14px;border:1px solid #e3b5b1;background:var(--danger-soft)}.confirm[hidden]{display:none}.confirm p{margin:0;color:#752522;font-size:12px}.card-status{min-height:18px;margin:14px 0 0;color:var(--accent);font-size:12px}.card-status.error{color:var(--danger)}.empty{padding:58px 24px;text-align:center;color:var(--muted)}.empty[hidden]{display:none}.pagination{display:flex;justify-content:space-between;padding-top:18px}.pagination a{color:var(--accent);font-size:12px;font-weight:650;text-decoration:none}.pagination a:hover{text-decoration:underline}.sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}@media(max-width:1080px){th:nth-child(6),.artifact-row td:nth-child(6){display:none}.inspector{grid-template-columns:1fr 1fr}}@media(max-width:900px){.shell{width:min(100% - 32px,680px)}main{padding-top:28px}.ledger{overflow:visible;border:0;background:transparent}table,tbody{display:block}thead{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.artifact-row{position:relative;display:grid;grid-template-columns:128px 1fr 40px;grid-template-rows:auto auto;min-height:104px;margin-top:-1px;border:1px solid var(--line);background:var(--white)}.artifact-row:hover{background:var(--white)}.artifact-row.is-open{border-color:var(--line-strong);background:var(--faint)}.artifact-row td{display:block;height:auto;padding:12px}.artifact-row td:nth-child(1){grid-column:1;grid-row:1/3;padding-right:4px}.artifact-row td:nth-child(2){grid-column:2;grid-row:1;padding:13px 4px 3px 10px}.artifact-row td:nth-child(3){grid-column:3;grid-row:2;padding:3px 8px 10px 0}.artifact-row td:nth-child(4),.artifact-row td:nth-child(5),.artifact-row td:nth-child(6){display:none}.artifact-row td:nth-child(7){grid-column:3;grid-row:1;padding:10px 8px 0 0}.preview-button{width:112px;height:78px}.artifact-title{font-size:14px}.artifact-id{margin-top:4px;font-size:10px}.badge{font-size:0}.badge:before{width:8px;height:8px}.inspect-button{width:32px;height:32px}.detail-row{display:block}.detail-row[hidden]{display:none}.detail-row td{display:block;padding:0}.inspector{margin:0 0 14px;display:block;box-shadow:none}.large-preview{min-height:250px;border-right:0;border-bottom:1px solid var(--line)}.large-preview .preview-media,.large-preview .preview-frame{min-height:250px}.large-preview .preview-image{padding:14px}.panel{padding:22px}}@media(max-width:520px){.shell{width:calc(100% - 24px)}.masthead,.masthead .shell{min-height:60px}.context{display:none}.owner-mark{font-size:11px}main{padding:24px 0 50px}.page-heading{align-items:start;margin-bottom:18px}h1{font-size:22px}.page-heading p{max-width:250px}.count{padding-top:5px;font-size:11px}.toolbar{align-items:stretch;gap:8px}.filter-wrap>span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}.filter-wrap select{min-width:108px;max-width:108px}.artifact-row{grid-template-columns:112px 1fr 38px;min-height:96px}.preview-button{width:96px;height:70px}.artifact-row td:nth-child(1){padding:12px 4px 12px 10px}.artifact-row td:nth-child(2){padding-left:7px}.panel{padding:18px}.panel-head{padding-bottom:16px}.summary,.expiry-grid{grid-template-columns:1fr}.share-line{align-items:stretch;flex-direction:column}.share-line .button{align-self:flex-start}.danger-line{align-items:start}.button-row{flex-wrap:wrap}}`;
}

function interactionStyles(): string {
  return `:root{--hover:#fafcfb;--preview:#eef1f0;--preview-large:#e8ecea;--accent-soft:#e7f0ed;--menu-shadow:0 12px 30px #17201d1f}html[data-theme="dark"]{color-scheme:dark;--ink:#e7ece9;--muted:#9ba8a2;--faint:#18201c;--line:#2c3732;--line-strong:#46534d;--accent:#72c7aa;--danger:#ff9b95;--danger-soft:#321e1d;--paper:#0f1412;--white:#151b18;--hover:#1a221e;--preview:#202824;--preview-large:#111714;--accent-soft:#193229;--menu-shadow:0 16px 36px #0008;--shadow:0 16px 36px #0007}.header-actions{display:flex;align-items:center;gap:14px}.theme-toggle{width:36px;height:36px;padding:0;display:grid;place-items:center;border:1px solid var(--line-strong);border-radius:4px;background:var(--white);color:var(--ink)}.theme-toggle:hover{background:var(--faint)}.theme-toggle svg{width:17px}.theme-toggle .sun{display:none}html[data-theme="dark"] .theme-toggle .moon{display:none}html[data-theme="dark"] .theme-toggle .sun{display:block}.ledger{overflow:visible}.artifact-row{cursor:pointer}.artifact-row:hover{background:var(--hover)}.artifact-link{display:block;color:inherit;text-decoration:none}.artifact-link:hover .artifact-title,.artifact-link:focus-visible .artifact-title{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}.preview-button,.preview-image,.preview-frame{background:var(--preview)}.large-preview{background:var(--preview-large)}.latest{background:var(--accent-soft)}.custom-select{position:relative;min-width:0}.custom-select:has([aria-expanded="true"]){z-index:30}.custom-trigger{width:100%;min-height:34px;padding:0 9px 0 11px;display:flex;align-items:center;justify-content:space-between;gap:8px;border:1px solid var(--line-strong);border-radius:4px;background:var(--white);color:var(--ink);font-size:12px;font-weight:600;text-align:left}.custom-trigger:hover,.custom-trigger[aria-expanded="true"]{border-color:var(--accent);background:var(--faint)}.custom-trigger svg{width:16px;flex:none;transition:transform .15s}.custom-trigger[aria-expanded="true"] svg{transform:rotate(180deg)}.custom-options{position:absolute;z-index:40;top:calc(100% + 5px);right:0;min-width:100%;padding:4px;border:1px solid var(--line-strong);border-radius:5px;background:var(--white);box-shadow:var(--menu-shadow)}.custom-options[hidden]{display:none}.custom-options button{width:100%;min-height:34px;padding:7px 10px;border:0;border-radius:3px;background:transparent;color:var(--ink);font-size:12px;text-align:left;white-space:nowrap}.custom-options button:hover,.custom-options button:focus-visible{background:var(--faint)}.custom-options button[aria-selected="true"]{color:var(--accent);font-weight:700}.custom-options button[aria-selected="true"]:after{content:"✓";float:right;margin-left:16px}.custom-options button:disabled{color:var(--muted)}.visibility-select{width:122px}.filter-select{width:145px}.filter-wrap .custom-trigger{height:38px}.panel .visibility-select{width:100%;margin-top:9px}.panel .custom-options{left:0;right:auto}.icon-button{width:36px;padding:0;display:grid;place-items:center;flex:none}.icon-button svg{width:17px}.toast{position:fixed;z-index:80;left:50%;bottom:26px;max-width:calc(100% - 32px);padding:10px 14px;border-radius:4px;background:#1f2b27;color:#fff;font-size:12px;box-shadow:var(--shadow);opacity:0;pointer-events:none;transform:translate(-50%,14px);transition:opacity .16s,transform .16s}.toast.show{opacity:1;transform:translate(-50%,0)}.toast.error{background:#772d29}.card-status{display:none}html[data-theme="dark"] .artifact-row:hover{background:var(--hover)}html[data-theme="dark"] .badge.public{color:#9ed8c3}html[data-theme="dark"] .badge.private{color:#b6c0bc}html[data-theme="dark"] .badge.secret_link{color:#d8bd86}html[data-theme="dark"] .button.primary{color:#0d1713}html[data-theme="dark"] .button.primary:hover{background:#8bd5ba}@media(max-width:900px){.artifact-row{grid-template-columns:128px minmax(0,1fr) 102px}.artifact-row td:nth-child(3){padding-right:8px}.visibility-select{width:94px}.visibility-select .custom-trigger{min-height:32px;font-size:11px}.panel .visibility-select{width:100%}}@media(max-width:520px){.artifact-row{grid-template-columns:96px minmax(0,1fr) 96px}.preview-button{width:84px}.artifact-title{font-size:13px}.latest{display:none}.owner-mark{display:none}.header-actions{gap:8px}.toast{bottom:16px}}`;
}

function themeStyles(): string {
  return `:root{--ink:#202821;--muted:#6f7368;--faint:#eee9dc;--line:#d8d0c0;--line-strong:#b8ad99;--accent:#285e46;--accent-hover:#1f4e3a;--on-accent:#fffaf0;--owner-dot:#2f7153;--danger:#99443a;--danger-soft:#fae9e4;--paper:#f4f0e6;--white:#fbf8f0;--hover:#f1ecdf;--preview:#e7e1d4;--preview-large:#ded7c9;--accent-soft:#dfe8dd;--menu-shadow:0 12px 30px #3b31241f;--shadow:0 12px 32px #3b312418}html[data-theme="dark"]{--ink:#f0eee8;--muted:#b0b4ac;--faint:#353a35;--line:#454c45;--line-strong:#606960;--accent:#d4a06d;--accent-hover:#e0ae7c;--on-accent:#2c241c;--owner-dot:#d4a06d;--danger:#f0a09a;--danger-soft:#4a302d;--paper:#252925;--white:#2d322e;--hover:#363c37;--preview:#3b413c;--preview-large:#333834;--accent-soft:#49392d;--menu-shadow:0 16px 36px #171a1780;--shadow:0 16px 36px #171a1766}:focus-visible{outline-color:var(--accent)}.owner-mark:before{background:var(--owner-dot)}.artifact-row:hover{background:var(--hover)}.artifact-summary{display:-webkit-box;margin-top:5px;overflow:hidden;color:var(--muted);font-size:12px;line-height:1.35;-webkit-box-orient:vertical;-webkit-line-clamp:1}.meta{color:var(--ink);opacity:.82}.inspect-button,.button{color:var(--ink)}.button.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}.button.primary:hover{background:var(--accent-hover)}.confirm p{color:var(--danger)}.panel-head .panel-description{max-width:420px;margin-top:8px;color:var(--muted);font:12px/1.45 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:normal}.panel-head .panel-id{margin-top:6px;color:var(--muted);font:11px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace}html[data-theme="dark"] .badge.public{color:#e3b583}html[data-theme="dark"] .badge.private{color:#c4c8c1}html[data-theme="dark"] .badge.secret_link{color:#d9bd94}html[data-theme="dark"] .button.primary{color:var(--on-accent)}html[data-theme="dark"] .button.primary:hover{background:var(--accent-hover)}@media(max-width:900px){.artifact-summary{-webkit-line-clamp:2}}`;
}

function darkThemeStyles(): string {
  return `html[data-theme="dark"]{--ink:#eeede7;--muted:#a5aaa2;--faint:#20251f;--line:#303630;--line-strong:#4b534b;--accent:#d6a36f;--accent-hover:#e3b27e;--on-accent:#211a14;--owner-dot:#d6a36f;--danger:#efa09a;--danger-soft:#351f1d;--paper:#0c0f0d;--white:#141814;--hover:#1d221e;--preview:#222722;--preview-large:#191d1a;--accent-soft:#31251d;--menu-shadow:0 18px 42px #000c;--shadow:0 18px 42px #0009}`;
}

function behaviorStyles(): string {
  return `html{scrollbar-gutter:stable}.identity{align-items:center}.brand{display:flex;align-items:center;gap:8px}.brand-mark{width:26px;height:28px;flex:none}.brand-ribbon{fill:#b8783d}.brand-fold{fill:#285e46}html[data-theme="dark"] .brand-ribbon{fill:#d6a36f}html[data-theme="dark"] .brand-fold{fill:#4c9874}.artifact-link:hover .artifact-title,.artifact-link:focus-visible .artifact-title{text-decoration:none}.artifact-link:hover .artifact-name,.artifact-link:focus-visible .artifact-name{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}th:nth-child(7){width:104px}.row-action{gap:6px}.row-copy svg{width:17px}.visibility-select .custom-trigger:disabled{cursor:wait;opacity:1}.preview-media{position:relative;overflow:hidden}.preview-frame{position:absolute;inset:0 auto auto 0;pointer-events:none;transform-origin:top left}.preview-frame{background:#fff}`;
}

export async function ownerPage(
  request: Request,
  db: D1Database,
  privateOrigin: string,
  publicOrigin: string,
  shareOrigin: string,
  secretEncryptionKey?: string,
): Promise<Response> {
  const url = new URL(request.url);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return Response.json({ error: "invalid_offset" }, { status: 400 });
  }
  const { results } = await db
    .prepare(
      "SELECT id, name, description, visibility, secret_hash, secret_ciphertext, secret_iv, " +
        "share_expires_at, hard_expires_at, created_at, updated_at FROM assets WHERE state = 'live' AND " +
        "(hard_expires_at IS NULL OR hard_expires_at > ?) " +
        "ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
    )
    .bind(new Date().toISOString(), pageSize + 1, offset)
    .all<OwnerAssetRow>();
  const recovered = await Promise.all(
    results.map(async (asset): Promise<OwnerAsset> => {
      let secretUrl: string | null = null;
      if (
        asset.secret_hash !== null &&
        asset.secret_ciphertext !== null &&
        asset.secret_iv !== null &&
        secretEncryptionKey !== undefined
      ) {
        try {
          const secret = await decryptSecret(
            asset.secret_ciphertext,
            asset.secret_iv,
            asset.id,
            secretEncryptionKey,
          );
          if ((await hashSecret(secret)) === asset.secret_hash) {
            secretUrl = `${shareOrigin}/s/${secret}/assets/${asset.id}/`;
          }
        } catch {
          // A missing, rotated, or corrupt key must not expose an invalid capability.
        }
      }
      return {
        ...asset,
        has_secret: asset.secret_hash === null ? 0 : 1,
        secret_url: secretUrl,
      };
    }),
  );
  const assets = recovered.slice(0, pageSize);
  const nonceBytes = crypto.getRandomValues(new Uint8Array(18));
  const nonce = btoa(String.fromCharCode(...nonceBytes));
  const rows = assets
    .map((asset, index) =>
      assetRows(asset, offset === 0 && index === 0, privateOrigin, publicOrigin),
    )
    .join("");
  const previous =
    offset > 0
      ? `<a href="/?offset=${Math.max(0, offset - pageSize)}">← Newer</a>`
      : "<span></span>";
  const next =
    results.length > pageSize
      ? `<a href="/?offset=${offset + pageSize}">Older →</a>`
      : "<span></span>";
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>shlook / owner archive</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><style nonce="${nonce}">${styles()}${interactionStyles()}${themeStyles()}${darkThemeStyles()}${behaviorStyles()}</style></head><body>
  <header class="masthead"><div class="shell"><div class="identity"><span class="brand">${brandMark()}<span class="wordmark">shlook</span></span></div><div class="header-actions"><button class="theme-toggle" type="button" data-theme-toggle aria-label="Switch to dark mode"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="moon" d="M20 15.2A8.5 8.5 0 0 1 8.8 4 8.5 8.5 0 1 0 20 15.2Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><g class="sun" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="3.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></g></svg></button></div></div></header>
  <main class="shell"><div class="page-heading"><div><h1>Artifact archive</h1><p>Inspect and manage generated artifacts.</p></div><span class="count" data-count>${assets.length} ${assets.length === 1 ? "artifact" : "artifacts"}</span></div>
  <div class="toolbar" aria-label="Archive controls"><label class="search"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 21-4.35-4.35m2.35-5.15a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><span class="sr-only">Search artifacts</span><input data-search type="search" placeholder="Search name, description, or ID" autocomplete="off"></label><div class="filter-wrap"><span>Visibility</span><div class="custom-select filter-select" data-filter-menu data-value="all"><button class="custom-trigger" type="button" data-menu-button aria-haspopup="listbox" aria-expanded="false"><span data-menu-label>All visibility</span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button><div class="custom-options" data-menu-list role="listbox" hidden><button type="button" role="option" data-filter-option="all" aria-selected="true">All visibility</button><button type="button" role="option" data-filter-option="public" aria-selected="false">Public</button><button type="button" role="option" data-filter-option="private" aria-selected="false">Private</button><button type="button" role="option" data-filter-option="secret_link" aria-selected="false">Secret link</button></div></div></div></div>
  <section class="ledger" aria-label="Artifact archive"><table><thead><tr><th>Preview</th><th>Artifact</th><th>Visibility</th><th>Share expiration</th><th>Artifact expiration</th><th>Updated</th><th><span class="sr-only">Inspect</span></th></tr></thead><tbody>${rows}</tbody></table><div class="empty" data-empty${assets.length === 0 ? "" : " hidden"}>No live artifacts match this view.</div></section><nav class="pagination" aria-label="Archive pages">${previous}${next}</nav></main>
  <div class="toast" data-toast role="status" aria-live="polite"></div><script nonce="${nonce}">${script()}</script></body></html>`;
  return new Response(body, {
    headers: {
      "cache-control": "private, no-store",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}
