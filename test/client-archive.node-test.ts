import { strict as assert } from "node:assert";
import { test } from "node:test";

import { JSDOM } from "jsdom";

import { archiveClientScript } from "../src/ui/client-archive.ts";
import { initClientScript } from "../src/ui/client-init.ts";
import { sharedClientScript } from "../src/ui/client-shared.ts";
import { uploadClientScript } from "../src/ui/client-upload.ts";

const shareExpiry = "2030-01-02T03:04:00.000Z";
const hardExpiry = "2031-05-06T07:08:00.000Z";

function artifactMarkup(id: string, share: string, hard: string): string {
  return `<tr class="artifact-row" data-record="${id}" data-search-text="${id}" data-search="${id} private" data-visibility="private" aria-selected="false"><td><input data-select-item type="checkbox"><button data-inspect type="button"><img data-preview-image src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="><iframe data-preview-fallback data-src="/preview/${id}" hidden></iframe></button></td></tr><tr class="detail-row" data-detail="${id}" hidden><td><time data-local-time datetime="${share}"></time><input data-share-expiry data-iso="${share}" type="datetime-local"><input data-hard-expiry data-iso="${hard}" type="datetime-local"><button data-expiry type="button">Apply policy</button><div data-confirm data-confirm-for="${id}" hidden><button data-delete type="button">Delete</button><button data-cancel-delete type="button">Cancel</button></div></td></tr>`;
}

function archivePage(rows: string, count = "1 artifact"): string {
  return `<span data-count>${count}</span><section class="ledger"><table><tbody>${rows}</tbody></table></section><nav class="pagination"><span></span></nav>`;
}

function testPage(rows: string): string {
  return `<!doctype html><html><body>
    <button data-upload-open></button><button data-theme-toggle></button>
    <div data-upload-dialog hidden><form data-upload-form><button data-upload-close></button><label data-drop-zone><input data-upload-input></label><div data-upload-config hidden><input data-upload-name><textarea data-upload-description></textarea><input name="upload-visibility" value="private" checked><input name="upload-visibility" value="secret_link"><button data-upload-submit></button><span data-upload-status></span><div data-upload-result><span data-upload-result-label></span><a data-upload-result-url></a><button data-upload-copy></button><button data-upload-again></button></div><span data-upload-progress-label></span><div data-upload-progress></div></div></form></div>
    <button data-select-toggle><span data-select-icon></span><span data-select-done hidden></span></button><button data-batch-delete hidden></button>
    <input data-search><div data-filter-menu data-value="all"><span data-menu-label></span></div><span data-count></span><div data-empty></div><div data-toast></div>
    <section class="ledger"><table><tbody>${rows}</tbody></table></section><nav class="pagination"><a href="/?offset=20">Older</a></nav>
    <div data-action-confirm hidden><button data-action-confirm-cancel></button><button data-action-confirm-submit></button><span data-action-confirm-title></span><span data-action-confirm-copy></span></div>
  </body></html>`;
}

const clientScript = [
  sharedClientScript(),
  uploadClientScript(),
  archiveClientScript(),
  initClientScript(),
].join("");

function localDateTime(iso: string): string {
  const date = new Date(iso);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

test("preserves both expiries through archive refresh and policy save", async () => {
  const refreshedPage = archivePage(
    artifactMarkup("refreshed", shareExpiry, hardExpiry),
    "2 artifacts",
  );
  const dom = new JSDOM(testPage(artifactMarkup("initial", shareExpiry, hardExpiry)), {
    url: "https://owner.example.com/",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  const { window } = dom;
  let policyBody: Record<string, string | null> | undefined;

  try {
    window.matchMedia = () => ({ matches: false }) as MediaQueryList;
    window.scrollTo = () => {};
    Object.defineProperty(window.HTMLElement.prototype, "offsetParent", {
      configurable: true,
      get() {
        for (let element: HTMLElement | null = this; element; element = element.parentElement) {
          if (element.hidden) return null;
        }
        return this.isConnected ? window.document.body : null;
      },
    });
    window.fetch = async (input, init = {}) => {
      const path = typeof input === "string" ? input : input.url;
      if (path.includes("offset=20"))
        return { ok: true, text: async () => refreshedPage } as Response;
      if (path === "/api/assets/refreshed/expiry") {
        policyBody = JSON.parse(String(init.body));
        return { ok: true, json: async () => ({}) } as Response;
      }
      throw new Error(`Unexpected fetch: ${path}`);
    };
    window.eval(clientScript);

    const initialShare = window.document.querySelector<HTMLInputElement>("[data-share-expiry]");
    const initialHard = window.document.querySelector<HTMLInputElement>("[data-hard-expiry]");
    assert.equal(initialShare?.value, localDateTime(shareExpiry));
    assert.equal(initialHard?.value, localDateTime(hardExpiry));

    window.document.querySelector<HTMLElement>("[data-select-toggle]")?.click();
    window.document.querySelector<HTMLAnchorElement>(".pagination a")?.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const refreshedDetail = window.document.querySelector<HTMLElement>('[data-detail="refreshed"]');
    const refreshedShare = refreshedDetail?.querySelector<HTMLInputElement>("[data-share-expiry]");
    const refreshedHard = refreshedDetail?.querySelector<HTMLInputElement>("[data-hard-expiry]");
    assert.equal(refreshedShare?.value, localDateTime(shareExpiry));
    assert.equal(refreshedHard?.value, localDateTime(hardExpiry));
    assert.ok(refreshedDetail?.querySelector(".meta-sub"));

    const selection = window.document.querySelector<HTMLInputElement>(
      '[data-record="refreshed"] [data-select-item]',
    );
    assert.ok(selection);
    selection.checked = true;
    selection.dispatchEvent(new window.Event("change", { bubbles: true }));
    assert.equal(window.document.querySelector<HTMLElement>("[data-batch-delete]")?.hidden, false);

    assert.ok(refreshedDetail);
    refreshedDetail.hidden = false;
    const confirmation = refreshedDetail.querySelector<HTMLElement>("[data-confirm]");
    assert.ok(confirmation);
    confirmation.hidden = false;
    const first = confirmation.querySelector<HTMLElement>("[data-delete]");
    confirmation.querySelector<HTMLElement>("[data-cancel-delete]")?.focus();
    confirmation.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab" }));
    assert.equal(window.document.activeElement, first);

    assert.ok(refreshedShare);
    refreshedShare.value = "2032-09-10T11:12";
    refreshedDetail.querySelector<HTMLElement>("[data-expiry]")?.click();
    window.document.querySelector<HTMLElement>("[data-action-confirm-submit]")?.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    assert.deepEqual(policyBody, {
      shareExpiresAt: new Date(refreshedShare.value).toISOString(),
      hardExpiresAt: new Date(refreshedHard?.value ?? "").toISOString(),
    });
  } finally {
    dom.window.close();
  }
});
