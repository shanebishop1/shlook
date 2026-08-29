# shlook

`shlook` is a reusable, self-hosted Cloudflare package for publishing agent-created HTML,
static sites, and raster images. Publications are private by default; public and secret-link
sharing require an explicit visibility change.

## Security model

A deployment has three browser origins with different trust levels:

| Origin  | Purpose                                          | Cloudflare Access |
| ------- | ------------------------------------------------ | ----------------- |
| Owner   | Owner UI, health check, and all `/api` mutations | Required          |
| Private | Owner-authenticated artifact viewing             | Required          |
| Share   | Explicitly public and capability-link artifacts  | Not enabled       |

Untrusted artifacts can contain active HTML and JavaScript. They must never share an origin
with the owner UI or mutation API: same-origin artifact code could send owner-authorized API
requests. For that reason, one-origin path multiplexing such as `/api`, `/private`, and
`/share` on one hostname is not supported. Paths are not a browser security boundary.

## Deployment modes

Choose one of these secure topologies:

1. **Account with a domain:** assign three distinct hostnames, for example
   `owner.example.com`, `private.example.com`, and `share.example.com`. Disable the
   `workers.dev` and preview URLs so they cannot bypass Access.
2. **Account without a domain:** deploy three distinct Worker names. Their production URLs
   become three origins such as `shlook-owner.<workers-subdomain>.workers.dev`,
   `shlook-private.<workers-subdomain>.workers.dev`, and
   `shlook-share.<workers-subdomain>.workers.dev`. Enable Access separately on the owner and
   private `workers.dev` routes; leave only the share route unauthenticated.

All three deployments use the same D1 database and private R2 bucket. D1 stores metadata and
lifecycle state; R2 stores artifact bytes and must not have an `r2.dev` URL or public custom
domain. Apply the packaged D1 migrations before serving traffic.

Every deployed Worker must receive these non-secret variables through its operator-owned
Wrangler configuration:

```text
SHLOOK_OWNER_ORIGIN=https://<owner-host>
SHLOOK_PRIVATE_ORIGIN=https://<private-host>
SHLOOK_SHARE_ORIGIN=https://<share-host>
SHLOOK_OWNER_EMAIL=<owner-email>
```

The owner Worker also requires a 32-byte base64 encryption key stored as a Cloudflare Worker
secret named `SHLOOK_SECRET_ENCRYPTION_KEY`. It encrypts recoverable capability URLs at rest;
never place it in `vars`, source control, or agent output.

Set these operator-owned values for every CLI or agent environment:

```bash
export SHLOOK_API_ORIGIN="https://<owner-host>"
export SHLOOK_PRIVATE_ORIGIN="https://<private-host>"
export SHLOOK_SHARE_ORIGIN="https://<share-host>"
export CF_ACCESS_CLIENT_ID="<agent-service-token-client-id>"
export CF_ACCESS_CLIENT_SECRET="<agent-service-token-client-secret>"
```

Do not rely on package defaults for a self-hosted installation. See
[`skills/shlook/references/setup.md`](skills/shlook/references/setup.md) for the manual
operator checklist. The packaged `shlook setup` command does not create D1, R2, DNS,
Worker routes, Access applications, policies, or service tokens.

## Publish an artifact

Every new publication has a concise display name and may have a description:

```bash
shlook publish ./artifact \
  --name "Owner archive refinement" \
  --description "Responsive archive controls and theme study" \
  --json
```

Names are required by the current CLI and accept 1-80 characters. Descriptions are optional
and accept up to 500 characters. Both are stored in D1, returned by the owner API, and shown
and searched in the owner archive. Existing assets are assigned their prior eight-character ID
prefix when the metadata migration is applied.

The creation API accepts the same metadata as JSON:

```json
{
  "name": "Owner archive refinement",
  "description": "Responsive archive controls and theme study"
}
```

## Route grammar

- Owner: `/`, `/archive`, `/health`, and `/api/assets...`
- Private: `/latest[/<artifact-path>]` and `/assets/<asset-id>[/<artifact-path>]`
- Share: `/assets/<asset-id>[/<artifact-path>]` and
  `/s/<capability>/assets/<asset-id>[/<artifact-path>]`

Unknown routes and artifacts unavailable to the requested audience return `404`.

## Development

Requirements: Node.js 24 and pnpm 11.17.0.

```bash
pnpm install --frozen-lockfile
pnpm fmt
pnpm run ci
```

Oxlint owns linting and Oxfmt owns formatting. `pnpm run ci` runs lint, format checking,
strict TypeScript checking, tests, and a Wrangler dry-run build.

## License

MIT. See [`LICENSE`](LICENSE).
