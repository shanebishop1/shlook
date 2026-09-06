import { readOwnerAssets } from "./data";
import { ownerClientScript } from "./client-script";
import { ownerDocument } from "./render";
import { ownerStyles } from "./styles";

export function ownerFavicon(): Response {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="shlook"><rect width="128" height="128" rx="22" fill="#0c0f0d"/><path d="M22 29 106 11v31L52 54l54 14v31l-84 19V87l54-13-54-14z" fill="#4c9874"/><path d="m52 54 54-12-30 32-54-14z" fill="#d6a36f"/></svg>`;
  return new Response(svg, {
    headers: {
      "cache-control": "public, max-age=86400",
      "content-security-policy": "default-src 'none'; sandbox",
      "content-type": "image/svg+xml; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
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
  const ownerOrigin = url.origin;
  const offset = Number(url.searchParams.get("offset") ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return Response.json({ error: "invalid_offset" }, { status: 400 });
  }

  const { assets, hasMore } = await readOwnerAssets(db, offset, shareOrigin, secretEncryptionKey);
  const nonceBytes = crypto.getRandomValues(new Uint8Array(18));
  const nonce = btoa(String.fromCharCode(...nonceBytes));
  const body = ownerDocument({
    assets,
    hasMore,
    offset,
    ownerOrigin,
    privateOrigin,
    publicOrigin,
    nonce,
    styles: ownerStyles(),
    script: ownerClientScript(),
  });

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
