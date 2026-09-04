# shlook

`shlook` is a reusable, self-hosted Cloudflare package for publishing agent-created HTML,
static sites, and raster images. Publications are private by default; public and secret-link
sharing require an explicit visibility change.

## Security model

A deployment has four browser origins with different trust levels:

| Origin  | Purpose                                    | Cloudflare Access |
| ------- | ------------------------------------------ | ----------------- |
| Owner   | Owner UI/API and isolated archive previews | Required          |
| Private | Owner-authenticated artifact viewing       | Required          |
| Public  | Stable public artifact URLs                | Not enabled       |
| Share   | Secret capability-link artifacts           | Not enabled       |

All four must be distinct, pathless HTTPS origins.

Untrusted artifacts can contain active HTML and JavaScript. Normal artifact views must never
share an origin with the owner UI or mutation API: same-origin artifact code could send
owner-authorized API requests. The archive's authenticated `/preview/assets/**` route is a
narrow exception whose iframe and response policies force an opaque sandbox, deny network and
form actions, and block cross-site or passive browser-resource requests to `/api/**`. For that
reason, general one-origin path multiplexing such as `/api`, `/private`, and `/share` on one
hostname is not supported. Paths alone are not a browser security boundary.

## Deployment modes

Choose one of these secure topologies:

1. **Account with a domain:** deploy one Worker with four custom hostnames, for example
   `owner.example.com`, `private.example.com`, `public.example.com`, and `share.example.com`.
   Wrangler routes with `custom_domain: true` manage custom-domain DNS and certificates during
   deployment. Disable the `workers.dev` and preview URLs so they cannot bypass the hostname
   policies.
2. **Account without a domain:** deploy four distinct Worker names. Their production URLs
   become four origins such as `shlook-owner.<workers-subdomain>.workers.dev`,
   `shlook-private.<workers-subdomain>.workers.dev`,
   `shlook-public.<workers-subdomain>.workers.dev`, and
   `shlook-share.<workers-subdomain>.workers.dev`. Enable Access separately on the owner and
   private `workers.dev` routes; leave public and share unauthenticated.

All four surfaces use the same D1 database and private R2 bucket. D1 stores metadata and
lifecycle state; R2 stores artifact bytes and must not have an `r2.dev` URL or public custom
domain. Apply the packaged D1 migrations before serving traffic.

Every deployed Worker must receive these non-secret variables through its operator-owned
Wrangler configuration:

```text
SHLOOK_OWNER_ORIGIN=https://<owner-host>
SHLOOK_PRIVATE_ORIGIN=https://<private-host>
SHLOOK_PUBLIC_ORIGIN=https://<public-host>
SHLOOK_SHARE_ORIGIN=https://<share-host>
SHLOOK_OWNER_EMAIL=<owner-email>
```

The owner Worker also requires a 32-byte base64 encryption key stored as a Cloudflare Worker
secret named `SHLOOK_SECRET_ENCRYPTION_KEY`. It encrypts recoverable capability URLs at rest;
never place it in `vars`, source control, or agent output.

For the standard custom-domain topology, `shlook setup` can provision and deploy without a
browser. Give it a temporary Cloudflare API token, then plan and apply:

```bash
export CLOUDFLARE_API_TOKEN="<temporary-provisioning-token>"
shlook setup --plan --domain "example.com" --owner-email "owner@example.com" --json
shlook setup --apply --domain "example.com" --owner-email "owner@example.com" --json
```

`CLOUDFLARE_API_TOKEN` is preferred; `SHLOOK_CF_TOKEN` is a compatibility alias. Domain, owner
email, and optional account ID also fall back to `SHLOOK_DOMAIN`, `SHLOOK_OWNER_EMAIL`, and
`SHLOOK_ACCOUNT_ID`. The broad provisioning token is used only for setup and is never persisted.
It must be able to discover account and zone resources and manage D1, R2, Access applications,
policies and service tokens, Worker deployment/custom domains, and Worker secrets.

Setup stores generated runtime Access credentials in
`${XDG_CONFIG_HOME:-$HOME/.config}/shlook/auth.json`, its Wrangler configuration in
`.../shlook/deployment/wrangler.json`, and the generated encryption key in
`.../shlook/deployment/secret-encryption-key`. To transfer only the runtime connection, rerun
apply with `--show-connection-token` and pipe that bearer secret to another installation without
putting it in argv:

```bash
printf '%s\n' "$SHLOOK_CONNECTION_TOKEN" | shlook connect --json
```

The connection token contains only the deployment domain and Access service-token credentials;
it cannot provision Cloudflare. Existing environment profiles remain supported: set
`CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, and `SHLOOK_DOMAIN`, or use the four explicit
origin variables for a nonstandard topology. See
[`skills/shlook/references/setup.md`](skills/shlook/references/setup.md) for details and the
manual no-domain deployment.

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
- Public: `/assets/<asset-id>[/<artifact-path>]`
- Share: `/s/<capability>/assets/<asset-id>[/<artifact-path>]`

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
