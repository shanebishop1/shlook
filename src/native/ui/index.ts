import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ownerClientScript } from "../../ui/client-script.ts";
import { ownerFavicon } from "../../ui/favicon.ts";
import { ownerDocument } from "../../ui/render.ts";
import { ownerStyles } from "../../ui/styles.ts";
import type { OwnerAsset } from "../../ui/types.ts";
import type { NativeAsset } from "../api.ts";
import { sanitizeReturnPath } from "../login-redirect.ts";
import { loginDocument } from "./login.ts";
import { nativeRequestScript, nativePreviewScript } from "./transport.ts";
import { nativeUploadScript } from "./upload.ts";

export type NativeUiContext = {
  user: { id: string; displayName: string };
  role: "viewer" | "publisher";
};
export type NativeUiPage = { assets: NativeAsset[]; nextOffset: number | null };
export type NativeUiOptions = {
  readPage?: (offset: number) => NativeUiPage | Promise<NativeUiPage>;
};

function serve(response: ServerResponse, body: string, nonce: string, status = 200) {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self'; frame-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'`,
  );
  response.end(body);
}

function ownerAsset(asset: NativeAsset): OwnerAsset {
  return {
    id: asset.id,
    name: asset.name,
    description: asset.description,
    visibility: "private",
    has_secret: 0,
    secret_url: null,
    share_expires_at: null,
    hard_expires_at: asset.hardExpiresAt,
    created_at: asset.createdAt,
    updated_at: asset.updatedAt,
    author: asset.author,
  };
}

export function createNativeUiHandler(options: NativeUiOptions = {}) {
  const loginHandler = (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/login", "http://native.invalid");
    const nonce = randomBytes(18).toString("base64");
    serve(
      response,
      loginDocument(sanitizeReturnPath(url.searchParams.get("return")), nonce),
      nonce,
    );
  };
  const ownerHandler = async (
    request: IncomingMessage,
    response: ServerResponse,
    context: NativeUiContext,
  ) => {
    const url = new URL(request.url ?? "/", "http://native.invalid");
    if (url.pathname === "/ui/favicon.svg") {
      const favicon = ownerFavicon();
      response.statusCode = 200;
      favicon.headers.forEach((value, key) => response.setHeader(key, value));
      response.end(await favicon.text());
      return;
    }
    const nonce = randomBytes(18).toString("base64");
    if (url.pathname !== "/" && url.pathname !== "/archive") {
      serve(response, "Not found", nonce, 404);
      return;
    }
    const offset = Number(url.searchParams.get("offset") ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      serve(response, "Invalid archive offset", nonce, 400);
      return;
    }
    if (!options.readPage) throw new Error("Native UI requires an archive readPage adapter");
    const page = await options.readPage(offset);
    const publisher = context.role === "publisher";
    serve(
      response,
      ownerDocument({
        assets: page.assets.map(ownerAsset),
        hasMore: page.nextOffset !== null,
        offset,
        pageSize: 100,
        nextOffset: page.nextOffset,
        // Relative same-origin links avoid trusting proxy/Host headers in rendered markup.
        ownerOrigin: "",
        privateOrigin: "",
        publicOrigin: "",
        nonce,
        styles: ownerStyles(),
        script: ownerClientScript({
          requestScript: nativeRequestScript(),
          uploadScript: nativeUploadScript(),
          previewScript: nativePreviewScript(),
        }),
        capabilities: {
          publish: publisher,
          delete: publisher,
          hardExpiry: publisher,
          sharing: false,
          directories: true,
          resolvePreviewEntrypoint: true,
        },
        logout: true,
        favicon: "/ui/favicon.svg",
      }),
      nonce,
    );
  };
  return { loginHandler, ownerHandler };
}
