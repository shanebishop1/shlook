import test from "node:test";
import assert from "node:assert/strict";
import { auth, fixture, listen, request } from "./helpers.ts";
import { authenticateToken, createSession } from "../../src/native/auth.ts";
import {
  MAX_OUTSTANDING_TICKETS,
  VIEW_GRANT_TTL_MS,
  VIEW_TICKET_TTL_MS,
  issueViewTicket,
  redeemViewTicket,
} from "../../src/native/view-tickets.ts";

const navigation = {
  host: "owner.example",
  "sec-fetch-site": "cross-site",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
};

async function publish(port: number, token: string, html = "<h1>hello ticket</h1>") {
  const headers = auth(token);
  const created = await request(
    port,
    "POST",
    "/api/assets",
    { ...headers, "content-type": "application/json" },
    JSON.stringify({ name: "Ticket test" }),
  );
  const id = JSON.parse(created.body).asset.id as string;
  const uploaded = await request(
    port,
    "PUT",
    `/api/assets/${id}/files/index.html`,
    { ...headers, "content-length": String(Buffer.byteLength(html)) },
    html,
  );
  const finalized = await request(
    port,
    "POST",
    `/api/assets/${id}/finalize`,
    { ...headers, "content-type": "application/json" },
    JSON.stringify({ entrypoint: "index.html", files: [JSON.parse(uploaded.body).file] }),
  );
  assert.equal(finalized.status, 200, finalized.body);
  return id;
}

async function setup() {
  const f = fixture(),
    port = await listen(f.app.server);
  f.store.addUser("dashfleet", "Dashfleet");
  const viewer = f.store.issueToken({ userId: "dashfleet", name: "view-tickets", role: "viewer" });
  const first = await publish(port, f.token);
  const second = await publish(port, f.token, "<h1>other</h1>");
  const mint = (path: unknown, token = viewer.secret, host = "owner.example") =>
    request(
      port,
      "POST",
      "/api/view-tickets",
      { ...auth(token, host), "content-type": "application/json" },
      JSON.stringify({ path }),
    );
  const ticketOf = async (path: string) => {
    const response = await mint(path);
    assert.equal(response.status, 201, response.body);
    return JSON.parse(response.body) as { url: string; expiresAt: string };
  };
  const target = (url: string) => {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  };
  const cookieOf = (response: { headers: Record<string, unknown> }) => {
    const header = response.headers["set-cookie"] as string[] | undefined;
    return header?.[0];
  };
  return { f, port, viewer, first, second, mint, ticketOf, target, cookieOf };
}

test("a ticket redeems once into an artifact-scoped cookie and a clean URL", async () => {
  const { f, port, first, ticketOf, target, cookieOf } = await setup();
  try {
    const issued = await ticketOf(`/assets/${first}/index.html?view=full`);
    const url = new URL(issued.url);
    assert.equal(url.origin, "https://owner.example");
    assert.equal(url.pathname, `/assets/${first}/index.html`);
    assert.match(url.searchParams.get("shlook_ticket")!, /^shlook_vt_v1_[A-Za-z0-9_-]{43}$/);
    assert.equal(url.searchParams.get("view"), "full");
    const expires = Date.parse(issued.expiresAt) - Date.now();
    assert.ok(expires > 0 && expires <= VIEW_TICKET_TTL_MS);

    const redeemed = await request(port, "GET", target(issued.url), navigation);
    assert.equal(redeemed.status, 303);
    assert.equal(redeemed.headers.location, `/assets/${first}/index.html?view=full`);
    assert.equal(redeemed.headers["referrer-policy"], "no-referrer");
    assert.equal(redeemed.headers["cache-control"], "private, no-store");
    assert.equal(redeemed.body, "");
    const cookie = cookieOf(redeemed)!;
    assert.match(
      cookie,
      new RegExp(
        `^__Secure-shlook_view=[A-Za-z0-9_-]{43}; Path=/assets/${first}/; Secure; HttpOnly; SameSite=Lax; Max-Age=(\\d+)$`,
      ),
    );
    assert.ok(Number(/Max-Age=(\d+)/.exec(cookie)![1]) <= VIEW_GRANT_TTL_MS / 1000);
    const grant = cookie.split(";")[0]!;

    const page = await request(port, "GET", redeemed.headers.location as string, {
      ...navigation,
      cookie: grant,
    });
    assert.equal(page.status, 200);
    assert.match(page.body, /hello ticket/);
    const entry = await request(port, "GET", `/assets/${first}/`, { ...navigation, cookie: grant });
    assert.equal(entry.status, 302);
    assert.equal(entry.headers.location, `/assets/${first}/index.html`);
    assert.equal(entry.headers["set-cookie"], undefined, "grants are never renewed");
  } finally {
    await f.dispose();
  }
});

test("replay, expiry, wrong artifact and malformed tickets set no cookie", async () => {
  const { f, port, first, second, ticketOf, target, cookieOf } = await setup();
  try {
    const once = await ticketOf(`/assets/${first}/index.html`);
    assert.ok(cookieOf(await request(port, "GET", target(once.url), navigation)));
    const replay = await request(port, "GET", target(once.url), navigation);
    assert.equal(replay.status, 303);
    assert.equal(replay.headers.location, `/assets/${first}/index.html`);
    assert.equal(cookieOf(replay), undefined, "replay");

    const expired = await ticketOf(`/assets/${first}/index.html`);
    const ticket = new URL(expired.url).searchParams.get("shlook_ticket")!;
    assert.equal(redeemViewTicket(f.store, ticket, first, Date.now() + VIEW_TICKET_TTL_MS), null);
    assert.equal(
      cookieOf(await request(port, "GET", target(expired.url), navigation)),
      undefined,
      "expired tickets are burned and refused",
    );

    const wrong = await ticketOf(`/assets/${first}/index.html`);
    const moved = target(wrong.url).replace(first, second);
    const misuse = await request(port, "GET", moved, navigation);
    assert.equal(misuse.status, 303);
    assert.equal(misuse.headers.location, `/assets/${second}/index.html`);
    assert.equal(cookieOf(misuse), undefined, "wrong artifact");
    assert.equal(
      cookieOf(await request(port, "GET", target(wrong.url), navigation)),
      undefined,
      "a misused ticket is burned",
    );

    for (const bad of ["x", "shlook_vt_v1_short", `shlook_vt_v1_${"A".repeat(43)}`]) {
      const response = await request(
        port,
        "GET",
        `/assets/${first}/index.html?shlook_ticket=${bad}`,
        navigation,
      );
      assert.equal(response.status, 303);
      assert.equal(cookieOf(response), undefined, bad);
    }
    // Behind a local HTTPS proxy every peer is loopback: replays must not throttle sign-in.
    for (let index = 0; index < 20; index++)
      await request(port, "GET", target(once.url), navigation);
    assert.equal((await request(port, "GET", "/api/me", auth(f.token))).status, 200);
    const clean = await request(port, "GET", `/assets/${first}/index.html`, navigation);
    assert.equal(clean.status, 302, "without a grant the login page applies as before");
    assert.match(clean.headers.location as string, /^\/login\?return=/);
  } finally {
    await f.dispose();
  }
});

test("redemption requires a top-level GET navigation without credentials or Origin", async () => {
  const { f, port, first, ticketOf, target, cookieOf } = await setup();
  try {
    const variants: Array<[string, Record<string, string>]> = [
      ["HEAD", navigation],
      ["GET", { ...navigation, "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" }],
      ["GET", { ...navigation, "sec-fetch-dest": "iframe" }],
      ["GET", { ...navigation, origin: "https://evil.example" }],
      ["GET", { ...navigation, authorization: "Bearer nope" }],
      ["GET", { host: "owner.example" }],
    ];
    for (const [method, headers] of variants) {
      const issued = await ticketOf(`/assets/${first}/index.html`);
      const response = await request(port, method, target(issued.url), headers);
      assert.equal(response.status, 303, JSON.stringify(headers));
      assert.equal(response.headers.location, `/assets/${first}/index.html`);
      assert.equal(response.headers["referrer-policy"], "no-referrer");
      assert.equal(cookieOf(response), undefined, JSON.stringify(headers));
      // The ticket was not consumed by a refused variant, but it can still be used only once.
      assert.ok(cookieOf(await request(port, "GET", target(issued.url), navigation)));
    }
    const doubled = await ticketOf(`/assets/${first}/index.html`);
    const response = await request(
      port,
      "GET",
      `${target(doubled.url)}&shlook_ticket=${new URL(doubled.url).searchParams.get("shlook_ticket")}`,
      navigation,
    );
    assert.equal(cookieOf(response), undefined, "duplicate parameters are ambiguous");
  } finally {
    await f.dispose();
  }
});

test("a grant reads only its own artifact and nothing else", async () => {
  const { f, port, first, second, ticketOf, target, cookieOf } = await setup();
  try {
    const issued = await ticketOf(`/assets/${first}/index.html`);
    const grant = cookieOf(await request(port, "GET", target(issued.url), navigation))!.split(
      ";",
    )[0]!;
    const api = { host: "owner.example", cookie: grant };
    for (const [method, path, headers] of [
      ["GET", `/assets/${second}/index.html`, navigation],
      ["GET", `/preview/assets/${first}/index.html`, navigation],
      ["GET", "/archive", navigation],
      ["GET", "/api/assets", api],
      ["GET", `/api/assets/${first}`, api],
      ["GET", `/api/assets/${first}/download`, api],
      ["GET", "/api/me", api],
      ["DELETE", `/api/assets/${first}`, { ...api, origin: "https://owner.example" }],
    ] as Array<[string, string, Record<string, string>]>) {
      const response = await request(port, method, path, { ...headers, cookie: grant });
      assert.ok([302, 401, 403].includes(response.status), `${method} ${path}: ${response.status}`);
      assert.doesNotMatch(response.body, /hello ticket|Ticket test/);
    }
    // A normal session still takes priority and behaves as before.
    const session = createSession(f.store, authenticateToken(f.store, f.token)!);
    const owner = await request(port, "GET", `/assets/${second}/index.html`, {
      ...navigation,
      cookie: `${grant}; __Host-shlook_session=${session.id}`,
    });
    assert.equal(owner.status, 200);
  } finally {
    await f.dispose();
  }
});

test("revoking the ticket token or disabling its user ends tickets and grants", async () => {
  const { f, port, viewer, first, ticketOf, target, cookieOf } = await setup();
  try {
    const live = await ticketOf(`/assets/${first}/index.html`);
    const grant = cookieOf(await request(port, "GET", target(live.url), navigation))!.split(
      ";",
    )[0]!;
    const pending = await ticketOf(`/assets/${first}/index.html`);
    f.store.revokeToken(viewer.id);
    const after = await request(port, "GET", `/assets/${first}/index.html`, {
      ...navigation,
      cookie: grant,
    });
    assert.equal(after.status, 302, "revoked grant falls back to sign-in");
    assert.equal(cookieOf(await request(port, "GET", target(pending.url), navigation)), undefined);
    // The owner's own token is untouched.
    assert.equal((await request(port, "GET", "/api/me", auth(f.token))).status, 200);

    const second = f.store.issueToken({ userId: "dashfleet", name: "second", role: "viewer" });
    const issued = issueViewTicket(f.store, second.id, `/assets/${first}/index.html`);
    f.store.disableUser("dashfleet");
    assert.equal(redeemViewTicket(f.store, issued.ticket, first), null);
  } finally {
    await f.dispose();
  }
});

test("minting is bearer-only, read-scoped and validates the artifact path", async () => {
  const { f, port, first, mint } = await setup();
  try {
    const session = createSession(f.store, authenticateToken(f.store, f.token)!);
    const cookieMint = await request(
      port,
      "POST",
      "/api/view-tickets",
      {
        host: "owner.example",
        origin: "https://owner.example",
        cookie: `__Host-shlook_session=${session.id}`,
        "x-shlook-csrf": session.csrfToken,
        "content-type": "application/json",
      },
      JSON.stringify({ path: `/assets/${first}/index.html` }),
    );
    assert.equal(cookieMint.status, 403, "browser sessions cannot mint");
    assert.equal((await mint(`/assets/${first}/index.html`, "shlook_api_v1_bad")).status, 401);
    for (const path of [
      undefined,
      42,
      "/archive",
      "/api/assets",
      `/assets/${first}`,
      `/assets/${first}/../x`,
      `/assets/${first}/%2e%2e/x`,
      `//evil.example/assets/${first}/`,
      `https://evil.example/assets/${first}/`,
      `/assets/${first}/index.html?shlook_ticket=x`,
      `/assets/${first}/index.html?a=1&shlook%5Fticket=x`,
      `/assets/${first}/index.html#frag`,
      `/assets/${first}/\u0000`,
      `/assets/${first}/${"a".repeat(5000)}`,
    ]) {
      const response = await mint(path);
      assert.equal(response.status, 400, String(path));
    }
    assert.equal((await mint("/assets/00000000-0000-0000-0000-000000000000/x")).status, 404);
    const alias = await mint(`/assets/${first}/`, undefined, "alias.example");
    assert.equal(alias.status, 201);
    assert.ok(JSON.parse(alias.body).url.startsWith(`https://alias.example/assets/${first}/?`));
  } finally {
    await f.dispose();
  }
});

test("outstanding tickets per token are capped", async () => {
  const { f, viewer, first } = await setup();
  try {
    for (let index = 0; index < MAX_OUTSTANDING_TICKETS; index++)
      issueViewTicket(f.store, viewer.id, `/assets/${first}/`);
    assert.throws(
      () => issueViewTicket(f.store, viewer.id, `/assets/${first}/`),
      /too_many_tickets/,
    );
    // Expired tickets free their slots.
    assert.ok(
      issueViewTicket(f.store, viewer.id, `/assets/${first}/`, Date.now() + VIEW_TICKET_TTL_MS),
    );
  } finally {
    await f.dispose();
  }
});
