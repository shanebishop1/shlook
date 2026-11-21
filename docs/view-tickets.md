# View tickets (native)

A view ticket lets a trusted server, such as a dashboard, open one private artifact in a
browser that has no shlook session. A typical case is a phone's in-app browser or a private
tab. The dashboard keeps a shlook API token on its server. The browser only ever sees a ticket
that works once, for a few minutes, for one artifact.

Nothing changes for links opened any other way. Artifacts stay private, and without a valid
ticket or grant shlook answers exactly as before (the sign-in page).

## How it works

1. The dashboard calls `POST /api/view-tickets` with `Authorization: Bearer <token>` and
   `{"path": "/assets/<id>/<file>[?query]"}`.
   - It gets back `201 {"url", "expiresAt"}`, where the URL carries
     `shlook_ticket=shlook_vt_v1_...`.
   - The path must be a valid artifact view path for a live asset.
   - Only Bearer tokens with the viewer or publisher role can mint. Browser sessions cannot.
2. The browser opens that URL. shlook deletes the ticket the first time it sees it, whatever
   happens next. It then answers `303` to the same URL without `shlook_ticket`, with
   `Referrer-Policy: no-referrer`.
3. If the ticket was valid, the redirect also sets
   `__Secure-shlook_view=<random>; Path=/assets/<id>/; Secure; HttpOnly; SameSite=Lax`, lasting
   one hour. Validity means:
   - unexpired;
   - for this artifact;
   - redeemed by a browser's top-level GET navigation (Fetch Metadata `navigate`/`document`) with
     no Origin or Authorization header;
   - from an active token whose user is enabled.
4. That cookie, a _grant_, lets the browser read that one artifact's pages (GET or HEAD under
   `/assets/<id>/`). It never reaches the archive, the API, previews, downloads or any other
   artifact, and it is never renewed. A normal signed-in session always takes priority.

| Item                 | Lifetime                                          | Stored as                 |
| -------------------- | ------------------------------------------------- | ------------------------- |
| Ticket               | 5 minutes, single use, capped by token expiry     | SHA-256 in `view_tickets` |
| Grant cookie         | 1 hour, one artifact path, capped by token expiry | SHA-256 in `view_grants`  |
| Ticket-issuing token | your choice (365 days recommended)                | SHA-256 in `tokens`       |

Each token can hold at most 256 unexpired tickets. Expired rows are removed by the hourly
cleanup and by `shlook-server cleanup`.

## Threat model

| Threat                                                                                          | Result                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The long-lived token leaks through a URL, history, Referer, screenshot or shared link           | It can't: the token stays on the dashboard's server, and URLs carry only a ticket.                                                                                                                                                               |
| A ticket is replayed (from history, a proxy log or a copied link)                               | Refused: it was deleted at first use, so the replay gets no cookie.                                                                                                                                                                              |
| A ticket is used late                                                                           | Refused after 5 minutes.                                                                                                                                                                                                                         |
| A ticket is used on another artifact                                                            | Refused, and the ticket is burned.                                                                                                                                                                                                               |
| A ticket is redeemed by a fetch, iframe, image, HEAD, link-preview bot or another site's script | No grant. Redemption needs a top-level GET navigation (`Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`) without Origin. A refused request does not consume the ticket. Browsers that send no Fetch Metadata see the sign-in page instead. |
| A ticket leaks through Referer                                                                  | The redemption redirect sends `Referrer-Policy: no-referrer` and the final URL has no ticket. Artifact pages already send `no-referrer`.                                                                                                         |
| A grant cookie is stolen                                                                        | It is HttpOnly and Secure, lasts at most an hour, and reads one artifact only. Revoking the token ends it at once.                                                                                                                               |
| The dashboard is compromised                                                                    | The attacker can read the shared library (viewer role) but cannot publish, delete or change expiry. Revoke the token to cut it off.                                                                                                              |

Grants carry viewer rights even if the minting token is a publisher. Use a dedicated user and a
viewer token anyway, so the credential can be revoked on its own.

## Provision a ticket issuer

Give the dashboard its own user and viewer token. Then revoking it never touches your own
tokens:

```bash
shlook-server user add dashfleet --display-name "Dashfleet" --data-dir <data-dir>
shlook-server token issue --user dashfleet --name dashfleet-view-tickets --role viewer \
  --expires <UTC timestamp up to 365 days ahead> --token-file <new absolute path> \
  --data-dir <data-dir>
```

Move the token file into the dashboard's secret store without printing it, then delete the
file. The server does not need a restart.

## Rotate or revoke

Rotate the token before it expires. Issue a new one, install it in the dashboard, then revoke
the old one:

```bash
shlook-server token issue --user dashfleet --name dashfleet-view-tickets-<yyyymmdd> --role viewer \
  --expires <UTC timestamp up to 365 days ahead> --token-file <new absolute path> --data-dir <data-dir>
shlook-server token list --user dashfleet --data-dir <data-dir>
shlook-server token revoke <old-token-id> --data-dir <data-dir>
```

Revoking a token deletes its outstanding tickets and grants. `shlook-server user disable
dashfleet` does the same for every token of that user. Neither affects other users' tokens or
sessions.

## Compatibility

View tickets are a native-backend feature. Schema migration 5 adds the two tables; earlier
shlook releases refuse a database that has it, so roll back by restoring the pre-upgrade backup.
The Cloudflare deployment has no ticket route.
