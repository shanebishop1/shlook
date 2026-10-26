import { readOwnerAssets } from "./data";
import { ownerClientScript } from "./client-script";
import { ownerDocument } from "./render";
import { ownerStyles } from "./styles";

export { ownerFavicon } from "./favicon.ts";

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

  const { assets, hasMore, total } = await readOwnerAssets(
    db,
    offset,
    shareOrigin,
    secretEncryptionKey,
  );
  const nonceBytes = crypto.getRandomValues(new Uint8Array(18));
  const nonce = btoa(String.fromCharCode(...nonceBytes));
  const body = ownerDocument({
    assets,
    hasMore,
    total,
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
