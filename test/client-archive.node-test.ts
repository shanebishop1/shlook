import { strict as assert } from "node:assert";
import { test } from "node:test";

import { JSDOM, VirtualConsole } from "jsdom";

import { archiveClientScript } from "../src/ui/client-archive.ts";
import { initClientScript } from "../src/ui/client-init.ts";
import { sharedClientScript } from "../src/ui/client-shared.ts";
import { uploadClientScript } from "../src/ui/client-upload.ts";
import { archiveRefreshScript } from "../src/ui/archive-refresh.ts";
import { ownerClientScript } from "../src/ui/client-script.ts";

const shareExpiry = "2030-01-02T03:04:00.000Z";
const hardExpiry = "2031-05-06T07:08:00.000Z";

function artifactMarkup(id: string, share: string, hard: string): string {
  return `<tr class="artifact-row" data-record="${id}" data-search-text="${id}" data-search="${id} private" data-visibility="private" aria-selected="false"><td><input data-select-item type="checkbox"><button data-inspect aria-expanded="false" type="button"><img data-preview-image src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="><iframe data-preview-fallback data-src="/preview/${id}" hidden></iframe></button></td></tr><tr class="detail-row" data-detail="${id}" hidden><td><time data-local-time datetime="${share}"></time><input data-share-expiry data-iso="${share}" type="datetime-local"><input data-hard-expiry data-iso="${hard}" type="datetime-local"><button data-expiry type="button">Apply policy</button><button data-request-delete type="button">Delete artifact</button><div data-confirm data-confirm-for="${id}" hidden><button data-delete type="button">Delete</button><button data-cancel-delete type="button">Cancel</button></div></td></tr>`;
}

function archivePage(rows: string, count = "1 artifact"): string {
  return `<span data-count>${count}</span><section class="ledger"><table><tbody>${rows}</tbody></table></section><nav class="pagination"><span></span></nav>`;
}

function testPage(rows: string): string {
  return `<!doctype html><html><body>
    <button data-upload-open></button><button data-theme-toggle></button>
    <div data-upload-dialog hidden><form data-upload-form><button data-upload-close></button><label data-drop-zone><input data-upload-input></label><div data-upload-config hidden><h2 tabindex="-1">Upload options</h2><input data-upload-name><textarea data-upload-description></textarea><input name="upload-visibility" value="private" checked><input name="upload-visibility" value="secret_link"><button data-upload-submit></button><span data-upload-status></span><div data-upload-result><span data-upload-result-label></span><a data-upload-result-url></a><button data-upload-copy></button><button data-upload-again></button></div><span data-upload-progress-label></span><div data-upload-progress></div></div></form></div>
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

test("archive refresh recovers only 401 through a same-origin document navigation", async () => {
  for (const status of [401, 403]) {
    const dom = new JSDOM(testPage(artifactMarkup("initial", shareExpiry, hardExpiry)), {
      url: "https://owner.example.com/",
      pretendToBeVisual: true,
      runScripts: "outside-only",
    });
    const { window } = dom;
    let destination: string | undefined;
    try {
      window.matchMedia = () => ({ matches: false }) as MediaQueryList;
      window.fetch = async () => new Response(null, { status });
      Object.assign(window, {
        recordNavigation: (path: string) => {
          destination = path;
        },
      });
      window.eval(`(() => {
        const location = { origin: 'https://owner.example.com', assign: window.recordNavigation };
        ${clientScript}
      })();`);
      window.document.querySelector<HTMLAnchorElement>(".pagination a")!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      assert.equal(destination, status === 401 ? "/?offset=20" : undefined);
    } finally {
      window.close();
    }
  }
});

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

class Clock {
  now = 0;
  next = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  setTimeout = (callback: () => void, delay: number) => {
    const id = ++this.next;
    this.timers.set(id, { at: this.now + delay, callback });
    return id;
  };
  clearTimeout = (id: unknown) => {
    this.timers.delete(id as number);
  };
  advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.timers]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.now = end;
  }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("lifecycle waits 120 seconds, never overlaps, and rearms only after completion", async () => {
  const clock = new Clock();
  let active = true;
  let safe = true;
  const calls: {
    signal: AbortSignal;
    fresh: () => boolean;
    done: ReturnType<typeof deferred<void>>;
  }[] = [];
  const createRefresh = new Function(`return (${archiveRefreshScript()});`)() as (environment: {
    active: () => boolean;
    safe: () => boolean;
    request: (signal: AbortSignal, fresh: () => boolean) => Promise<void>;
    setTimeout: Clock["setTimeout"];
    clearTimeout: Clock["clearTimeout"];
  }) => { notify: (restored?: boolean) => void; interaction: () => void };
  const refresh = createRefresh({
    ...clock,
    active: () => active,
    safe: () => safe,
    request: (signal, fresh) => {
      const done = deferred<void>();
      calls.push({ signal, fresh, done });
      return done.promise;
    },
  });
  refresh.notify();
  await settle();
  assert.equal(calls.length, 0);
  clock.advance(119999);
  await settle();
  assert.equal(calls.length, 0);
  clock.advance(1);
  await settle();
  assert.equal(calls.length, 1);
  clock.advance(300000);
  refresh.notify(true);
  await settle();
  assert.equal(calls.length, 1);
  calls[0].done.resolve();
  await settle();
  clock.advance(119999);
  await settle();
  assert.equal(calls.length, 1);
  clock.advance(1);
  await settle();
  assert.equal(calls.length, 2);
  safe = false;
  refresh.interaction();
  safe = true;
  assert.equal(calls[1].signal.aborted, true);
  assert.equal(calls[1].fresh(), false, "begin/end cannot make a stale request fresh again");
  calls[1].done.resolve();
  await settle();
  assert.equal(calls.length, 3);
  active = false;
  refresh.notify();
  assert.equal(calls[2].signal.aborted, true);
  calls[2].done.resolve();
  await settle();
  clock.advance(600000);
  await settle();
  assert.equal(calls.length, 3);
  active = true;
  refresh.notify();
  refresh.notify();
  refresh.notify(true);
  await settle();
  assert.equal(calls.length, 4);
  calls[3].done.resolve();
  await settle();
});

function passiveFixture(
  options: {
    focused?: boolean;
    visible?: boolean;
    rows?: string;
    scripts?: Parameters<typeof ownerClientScript>[0];
  } = {},
) {
  const rows = options.rows ?? artifactMarkup("initial", shareExpiry, hardExpiry);
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error: Error) => errors.push(error.message));
  const dom = new JSDOM(testPage(rows), {
    url: "https://owner.example.com/?offset=40&limit=20",
    pretendToBeVisual: true,
    runScripts: "outside-only",
    virtualConsole,
  });
  const { window } = dom;
  const clock = new Clock();
  let focused = options.focused ?? true;
  let visible = options.visible ?? true;
  const calls: { path: string; init: RequestInit }[] = [];
  const navigations: string[] = [];
  let handler: (path: string, init: RequestInit) => Promise<Response> = async () =>
    new Response(archivePage(rows));
  window.matchMedia = () => ({ matches: false }) as MediaQueryList;
  window.scrollTo = () => {
    throw new Error("Passive refresh must not scroll");
  };
  window.document.hasFocus = () => focused;
  Object.defineProperty(window.document, "visibilityState", {
    get: () => (visible ? "visible" : "hidden"),
  });
  window.setTimeout = clock.setTimeout as typeof window.setTimeout;
  window.clearTimeout = clock.clearTimeout;
  window.fetch = (input, init = {}) => {
    const path = String(input);
    calls.push({ path, init });
    return handler(path, init);
  };
  Object.assign(window, { recordNavigation: (path: string) => navigations.push(path) });
  window.eval(`(() => {
    const location = { origin: window.location.origin, get pathname() { return window.location.pathname; }, get search() { return window.location.search; }, assign: window.recordNavigation };
    ${ownerClientScript(options.scripts)}
  })();`);
  return {
    window,
    clock,
    calls,
    navigations,
    handler: (next: typeof handler) => {
      handler = next;
    },
    focus: (value: boolean) => {
      focused = value;
      window.dispatchEvent(new window.Event(value ? "focus" : "blur"));
    },
    visible: (value: boolean) => {
      visible = value;
      window.document.dispatchEvent(new window.Event("visibilitychange"));
    },
    close: () => {
      window.close();
      assert.deepEqual(errors, [], "unexpected browser runtime errors");
    },
  };
}

test("hidden or visible-unfocused pages do no work; return and BFcache refresh once", async () => {
  const fixture = passiveFixture({ focused: false, visible: false });
  try {
    const { clock, calls, window } = fixture;
    await settle();
    clock.advance(600000);
    fixture.visible(true);
    clock.advance(600000);
    await settle();
    assert.equal(calls.length, 0);
    fixture.focus(true);
    window.document.dispatchEvent(new window.Event("visibilitychange"));
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "/?offset=40&limit=20");
    assert.equal(window.location.search, "?offset=40&limit=20");
    window.dispatchEvent(new window.PageTransitionEvent("pageshow", { persisted: false }));
    await settle();
    assert.equal(calls.length, 1);
    window.dispatchEvent(new window.PageTransitionEvent("pagehide"));
    clock.advance(300000);
    window.dispatchEvent(new window.PageTransitionEvent("pageshow", { persisted: true }));
    window.dispatchEvent(new window.Event("focus"));
    await settle();
    assert.equal(calls.length, 2);
    window.dispatchEvent(new window.PageTransitionEvent("pageshow", { persisted: true }));
    await settle();
    assert.equal(calls.length, 3, "active BFcache restore refreshes even without blur");
  } finally {
    fixture.close();
  }
});

test("passive reconciliation preserves query, filters, selection, surviving focus and existing previews while waiting", async () => {
  const fixture = passiveFixture({
    rows:
      artifactMarkup("keep", shareExpiry, hardExpiry) +
      artifactMarkup("gone", shareExpiry, hardExpiry),
  });
  try {
    const { window, clock, calls } = fixture;
    const document = window.document;
    const response = deferred<Response>();
    fixture.handler(() => response.promise);
    document.querySelector<HTMLElement>("[data-select-toggle]")!.click();
    document.querySelectorAll<HTMLInputElement>("[data-select-item]").forEach((item) => {
      item.checked = true;
    });
    document.querySelector<HTMLInputElement>("[data-search]")!.value = "keep";
    document.querySelector<HTMLElement>("[data-filter-menu]")!.dataset.value = "private";
    const focus = document.querySelector<HTMLElement>('[data-record="keep"] [data-select-item]')!;
    focus.focus();
    const frame = document.querySelector("iframe")!;
    frame.setAttribute("src", "/existing-preview");
    await settle();
    clock.advance(120000);
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(frame.getAttribute("src"), "/existing-preview");
    response.resolve(
      new Response(
        archivePage(
          artifactMarkup("keep", shareExpiry, hardExpiry) +
            artifactMarkup("new", shareExpiry, hardExpiry),
          "2 artifacts",
        ),
      ),
    );
    await settle();
    assert.equal(document.querySelector<HTMLInputElement>("[data-search]")!.value, "keep");
    assert.equal(
      document.querySelector<HTMLElement>("[data-filter-menu]")!.dataset.value,
      "private",
    );
    assert.equal(
      document.querySelector<HTMLInputElement>('[data-record="keep"] [data-select-item]')!.checked,
      true,
    );
    assert.equal(
      document.querySelector<HTMLInputElement>('[data-record="new"] [data-select-item]')!.checked,
      false,
    );
    assert.equal(document.querySelector<HTMLElement>('[data-record="new"]')!.hidden, true);
    assert.equal(
      document.activeElement?.closest<HTMLElement>("[data-record]")?.dataset.record,
      "keep",
    );
    assert.equal(document.body.classList.contains("selection-mode"), true);
    assert.equal(document.querySelector<HTMLElement>("[data-batch-delete]")!.hidden, false);
    assert.equal(document.querySelector("[data-toast]")!.textContent, "");
    assert.equal(window.location.search, "?offset=40&limit=20");
    await settle();
    assert.equal(calls.length, 1, "DOM commit must not schedule a refresh loop");
  } finally {
    fixture.close();
  }
});

test("inspectors, menus, confirmations, upload dialogs, and collapsed dirty expiries defer one refresh until safe", async () => {
  for (const blocker of ["inspector", "menu", "confirmation", "action", "upload", "dirty"]) {
    const fixture = passiveFixture();
    try {
      const { window, clock, calls } = fixture;
      const document = window.document;
      let unblock: () => void;
      if (blocker === "dirty") {
        const input = document.querySelector<HTMLInputElement>("[data-share-expiry]")!;
        const baseline = input.value;
        input.value = "2035-01-01T12:30";
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
        unblock = () => {
          input.value = baseline;
          input.dispatchEvent(new window.Event("input", { bubbles: true }));
        };
      } else {
        const selector = {
          inspector: "[data-detail]",
          confirmation: "[data-confirm]",
          action: "[data-action-confirm]",
          upload: "[data-upload-dialog]",
          menu: "[data-menu-list]",
        }[blocker]!;
        let element = document.querySelector<HTMLElement>(selector);
        if (!element) {
          element = document.createElement("div");
          element.dataset.menuList = "";
          document.body.append(element);
        }
        element.hidden = false;
        unblock = () => {
          element!.hidden = true;
        };
      }
      await settle();
      clock.advance(120000);
      await settle();
      assert.equal(calls.length, 0, blocker);
      clock.advance(600000);
      await settle();
      assert.equal(calls.length, 0, `${blocker} must not poll`);
      unblock();
      await settle();
      assert.equal(calls.length, 1, blocker);
    } finally {
      fixture.close();
    }
  }
});

test("inactive late responses, including 401 and late bodies, cannot commit or redirect", async () => {
  for (const phase of ["response", "body", "401"]) {
    const fixture = passiveFixture();
    try {
      const response = deferred<Response>();
      const body = deferred<string>();
      fixture.handler(() =>
        phase === "body"
          ? Promise.resolve({ ok: true, text: () => body.promise } as Response)
          : response.promise,
      );
      fixture.clock.advance(120000);
      await settle();
      const signal = fixture.calls[0].init.signal!;
      if (phase === "response") fixture.visible(false);
      else if (phase === "body")
        fixture.window.dispatchEvent(new fixture.window.PageTransitionEvent("pagehide"));
      else fixture.focus(false);
      assert.equal(signal.aborted, true);
      if (phase === "body")
        body.resolve(archivePage(artifactMarkup("stale", shareExpiry, hardExpiry)));
      else
        response.resolve(
          new Response(archivePage(artifactMarkup("stale", shareExpiry, hardExpiry)), {
            status: phase === "401" ? 401 : 200,
          }),
        );
      await settle();
      assert.ok(fixture.window.document.querySelector('[data-record="initial"]'));
      assert.equal(fixture.window.document.querySelector('[data-record="stale"]'), null);
      assert.deepEqual(fixture.navigations, []);
      fixture.clock.advance(600000);
      await settle();
      assert.equal(fixture.calls.length, 1);
    } finally {
      fixture.close();
    }
  }
});

test("open-close interaction during a passive request invalidates it even when safe again at response time", async () => {
  const fixture = passiveFixture();
  try {
    const stale = deferred<Response>();
    fixture.handler(() => stale.promise);
    fixture.clock.advance(120000);
    await settle();
    const inspect = fixture.window.document.querySelector<HTMLElement>("[data-inspect]")!;
    inspect.click();
    inspect.click();
    assert.equal(fixture.calls[0].init.signal!.aborted, true);
    fixture.handler(
      async () => new Response(archivePage(artifactMarkup("fresh", shareExpiry, hardExpiry))),
    );
    stale.resolve(new Response(archivePage(artifactMarkup("stale", shareExpiry, hardExpiry))));
    await settle();
    assert.equal(fixture.window.document.querySelector('[data-record="stale"]'), null);
    assert.ok(fixture.window.document.querySelector('[data-record="fresh"]'));
    assert.equal(fixture.calls.length, 2);
  } finally {
    fixture.close();
  }
});

test("foreground pagination cancels passive work and is never dropped behind it", async () => {
  const fixture = passiveFixture();
  try {
    const stale = deferred<Response>();
    fixture.handler((path) =>
      path.includes("offset=20")
        ? Promise.resolve(
            new Response(archivePage(artifactMarkup("page2", shareExpiry, hardExpiry))),
          )
        : stale.promise,
    );
    fixture.clock.advance(120000);
    await settle();
    fixture.window.scrollTo = () => {};
    fixture.window.document.querySelector<HTMLAnchorElement>(".pagination a")!.click();
    await settle();
    assert.equal(fixture.calls.length, 2);
    assert.equal(fixture.calls[0].init.signal!.aborted, true);
    assert.ok(fixture.window.document.querySelector('[data-record="page2"]'));
    assert.equal(fixture.window.location.search, "?offset=20");
    stale.resolve(new Response(null, { status: 401 }));
    await settle();
    assert.deepEqual(fixture.navigations, []);
    assert.ok(fixture.window.document.querySelector('[data-record="page2"]'));
  } finally {
    fixture.close();
  }
});

test("batch confirmation action remains busy after the dialog closes and defers refresh until completion", async () => {
  const fixture = passiveFixture();
  try {
    const mutation = deferred<Response>();
    fixture.handler((path) =>
      path.startsWith("/api/")
        ? mutation.promise
        : Promise.resolve(
            new Response(archivePage(artifactMarkup("fresh", shareExpiry, hardExpiry))),
          ),
    );
    const document = fixture.window.document;
    document.querySelector<HTMLElement>("[data-select-toggle]")!.click();
    const selected = document.querySelector<HTMLInputElement>("[data-select-item]")!;
    selected.checked = true;
    selected.dispatchEvent(new fixture.window.Event("change", { bubbles: true }));
    document.querySelector<HTMLElement>("[data-batch-delete]")!.click();
    document.querySelector<HTMLElement>("[data-action-confirm-submit]")!.click();
    await settle();
    assert.equal(document.querySelector<HTMLElement>("[data-action-confirm]")!.hidden, true);
    fixture.clock.advance(120000);
    await settle();
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].init.method, "DELETE");
    // A failed mutation keeps us in the current document without simulating reload.
    mutation.resolve(new Response(JSON.stringify({ error: "failed" }), { status: 500 }));
    await settle();
    assert.equal(fixture.calls.length, 2);
    assert.ok(document.querySelector('[data-record="fresh"]'));
  } finally {
    fixture.close();
  }
});

test("a mutation that begins and ends before the old response arrives still prevents stale redirects", async () => {
  const fixture = passiveFixture();
  try {
    const oldResponse = deferred<Response>();
    const mutation = deferred<Response>();
    fixture.handler((path) => (path.startsWith("/api/") ? mutation.promise : oldResponse.promise));
    fixture.clock.advance(120000);
    await settle();
    const document = fixture.window.document;
    document.querySelector<HTMLElement>("[data-select-toggle]")!.click();
    const selected = document.querySelector<HTMLInputElement>("[data-select-item]")!;
    selected.checked = true;
    selected.dispatchEvent(new fixture.window.Event("change", { bubbles: true }));
    document.querySelector<HTMLElement>("[data-batch-delete]")!.click();
    document.querySelector<HTMLElement>("[data-action-confirm-submit]")!.click();
    await settle();
    assert.equal(fixture.calls[0].init.signal!.aborted, true);
    assert.equal(fixture.calls.length, 2);
    mutation.resolve(new Response(JSON.stringify({ error: "failed" }), { status: 500 }));
    await settle();
    assert.equal(document.querySelector<HTMLElement>("[data-action-confirm]")!.hidden, true);
    assert.equal(
      fixture.calls.length,
      2,
      "must not overlap the old passive request even after mutation completion",
    );
    fixture.handler(
      async () => new Response(archivePage(artifactMarkup("fresh", shareExpiry, hardExpiry))),
    );
    oldResponse.resolve(new Response(null, { status: 401 }));
    await settle();
    assert.deepEqual(fixture.navigations, []);
    assert.equal(fixture.calls.length, 3);
    assert.ok(document.querySelector('[data-record="fresh"]'));
  } finally {
    fixture.close();
  }
});

test("custom request, upload and preview scripts remain usable; uploads defer passive work through completion", async () => {
  const rows = artifactMarkup("initial", shareExpiry, hardExpiry).replace(
    "data-preview-image ",
    'data-preview-image data-preview-entrypoint="index.html" ',
  );
  const fixture = passiveFixture({
    rows,
    scripts: {
      requestScript: `const ownerRequest = (path, init) => window.testOwnerRequest(path, init);`,
      uploadScript: `const chooseUploadFiles = (files) => chooseUploadFile(files[0]);
      const publishUpload = async () => { await ownerRequest('/custom-publish'); throw new Error('custom upload failed'); };`,
      previewScript: `window.previewResolutions = 0; const resolvePreview = async () => { window.previewResolutions++; };`,
    },
  });
  try {
    const upload = deferred<void>();
    const requests: string[] = [];
    Object.assign(fixture.window, {
      testOwnerRequest: (path: string) => {
        requests.push(path);
        return upload.promise;
      },
    });
    const document = fixture.window.document;
    document.querySelector<HTMLElement>("[data-upload-open]")!.click();
    const input = document.querySelector<HTMLInputElement>("[data-upload-input]")!;
    Object.defineProperty(input, "files", {
      value: [new fixture.window.File(["hello"], "hello.html", { type: "text/html" })],
    });
    input.dispatchEvent(new fixture.window.Event("change", { bubbles: true }));
    document
      .querySelector("form")!
      .dispatchEvent(new fixture.window.Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    assert.deepEqual(requests, ["/custom-publish"]);
    // Even if the dialog is hidden independently, the operation remains busy.
    document.querySelector<HTMLElement>("[data-upload-dialog]")!.hidden = true;
    fixture.clock.advance(120000);
    await settle();
    assert.equal(fixture.calls.length, 0);
    upload.resolve();
    await settle();
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].path, "/?offset=40&limit=20");
    assert.equal(
      document.querySelector("[data-upload-status]")!.textContent,
      "custom upload failed",
    );
    assert.equal(
      (fixture.window as unknown as { previewResolutions: number }).previewResolutions,
      2,
    );
  } finally {
    fixture.close();
  }
});

test("empty expiry baselines are clean; editing and reverting a collapsed field invalidates an in-flight body", async () => {
  const fixture = passiveFixture({ rows: artifactMarkup("initial", "", "") });
  try {
    const body = deferred<string>();
    fixture.handler(async () => ({ ok: true, text: () => body.promise }) as Response);
    fixture.clock.advance(120000);
    await settle();
    assert.equal(fixture.calls.length, 1, "empty ISO values must not look dirty");
    const input = fixture.window.document.querySelector<HTMLInputElement>("[data-hard-expiry]")!;
    input.value = "2035-01-01T12:30";
    input.dispatchEvent(new fixture.window.Event("input", { bubbles: true }));
    input.value = "";
    input.dispatchEvent(new fixture.window.Event("input", { bubbles: true }));
    fixture.handler(async () => new Response(archivePage(artifactMarkup("fresh", "", ""))));
    body.resolve(archivePage(artifactMarkup("stale", "", "")));
    await settle();
    assert.equal(fixture.window.document.querySelector('[data-record="stale"]'), null);
    assert.ok(fixture.window.document.querySelector('[data-record="fresh"]'));
  } finally {
    fixture.close();
  }
});

test("a programmatic inspector open-close in one turn invalidates a pending response", async () => {
  const fixture = passiveFixture();
  try {
    const response = deferred<Response>();
    fixture.handler(() => response.promise);
    fixture.clock.advance(120000);
    await settle();
    const detail = fixture.window.document.querySelector<HTMLElement>("[data-detail]")!;
    detail.hidden = false;
    detail.hidden = true;
    await settle();
    assert.equal(fixture.calls[0].init.signal!.aborted, true);
    fixture.handler(
      async () => new Response(archivePage(artifactMarkup("fresh", shareExpiry, hardExpiry))),
    );
    response.resolve(new Response(archivePage(artifactMarkup("stale", shareExpiry, hardExpiry))));
    await settle();
    assert.equal(fixture.window.document.querySelector('[data-record="stale"]'), null);
    assert.ok(fixture.window.document.querySelector('[data-record="fresh"]'));
  } finally {
    fixture.close();
  }
});

test("passive network, server and malformed failures are silent and retry after two minutes; fresh 401 recovers", async () => {
  for (const failure of ["network", "500", "malformed", "401"]) {
    const fixture = passiveFixture();
    try {
      fixture.handler(async () => {
        if (failure === "network") throw new Error("offline");
        return new Response("not an archive", {
          status: failure === "500" ? 500 : failure === "401" ? 401 : 200,
        });
      });
      fixture.clock.advance(120000);
      await settle();
      assert.ok(fixture.window.document.querySelector('[data-record="initial"]'));
      assert.equal(fixture.window.document.querySelector("[data-toast]")!.textContent, "");
      assert.deepEqual(fixture.navigations, failure === "401" ? ["/?offset=40&limit=20"] : []);
      fixture.handler(
        async () => new Response(archivePage(artifactMarkup("retry", shareExpiry, hardExpiry))),
      );
      fixture.clock.advance(119999);
      await settle();
      assert.equal(fixture.calls.length, 1);
      fixture.clock.advance(1);
      await settle();
      assert.equal(fixture.calls.length, 2);
      assert.ok(fixture.window.document.querySelector('[data-record="retry"]'));
    } finally {
      fixture.close();
    }
  }
});
