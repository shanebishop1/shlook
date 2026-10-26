import { escapeHtml } from "../../ui/render.ts";
import { ownerStyles } from "../../ui/styles.ts";

export function loginDocument(returnPath: string, nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title><style nonce="${nonce}">${ownerStyles()}
body { min-height:100svh; display:grid; place-items:center; padding:24px; }
#login { width:min(100%,360px); display:grid; gap:12px; }
#login label { font-size:14px; font-weight:600; }
#token { width:100%; min-width:0; min-height:48px; border:1px solid var(--line-strong); border-radius:5px; background:var(--white); color:var(--ink); padding:12px; font-size:16px; }
#login button { min-height:48px; }
#message { margin:0; color:var(--danger); }
</style><script nonce="${nonce}">try{document.documentElement.dataset.theme=localStorage.getItem('shlook-theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')}catch{document.documentElement.dataset.theme=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}</script></head><body><form id="login"><label for="token">API token</label> <input id="token" type="password" autocomplete="off" spellcheck="false" autocapitalize="none" required><button class="button primary" type="submit">Sign in</button><p id="message" role="alert" hidden></p><input type="hidden" name="return" value="${escapeHtml(returnPath)}"></form><script nonce="${nonce}">
const form = document.querySelector('#login');
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = document.querySelector('#token'), button = form.querySelector('button'), message = document.querySelector('#message');
  if (button.disabled) return;
  let token = input.value;
  input.value = '';
  button.disabled = true;
  message.hidden = true;
  try {
    const pending = fetch('/api/session', { method:'POST', headers:{'Content-Type':'application/json','X-Shlook-Login':'1'}, body:JSON.stringify({token}), credentials:'same-origin' });
    token = '';
    const response = await pending;
    if (!response.ok) throw new Error('Sign-in failed.');
    location.replace(form.elements.namedItem('return').value);
  } catch {
    message.textContent = 'Sign-in failed. Try again.';
    message.hidden = false;
    button.disabled = false;
    input.focus();
  } finally { token = ''; }
});</script></body></html>`;
}
