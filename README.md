# shlook

`shlook` is a self-hosted Cloudflare publication pipeline for agent-created HTML, static sites,
and raster images. The CLI and owner UI send artifacts to an owner-authenticated API;
publications remain private until an operator explicitly enables public or secret-link sharing.

### Key capabilities

- CLI setup, connection, and publication workflows that do not require a browser.
- An owner archive and API backed by D1 metadata/lifecycle state and private R2 bytes.
- Separate private, public, and capability-link delivery surfaces for untrusted artifacts.
- Plan/apply provisioning with operator-owned Wrangler configuration and short-lived setup
  credentials.

## Quick start

Requirements: Node.js 24. Install the published CLI with npm:

```bash
npm install --global shlook
```

For the standard custom-domain topology, provide a temporary Cloudflare API token, then plan
and apply the first deployment:

```bash
export CLOUDFLARE_API_TOKEN="<temporary-provisioning-token>"
shlook setup --plan --domain "example.com" --owner-email "owner@example.com" --json
shlook setup --apply --domain "example.com" --owner-email "owner@example.com" --json
shlook publish ./artifact --name "Owner archive refinement" --json
```

The setup token is used only for provisioning and is never persisted. Its required permissions,
the no-domain topology, and the manual deployment path are documented below.

## Architecture and trust boundary

The main path is deliberately small:

```text
shlook CLI --Access service token--> Owner origin / owner API
                                      ├── D1: metadata and lifecycle state
                                      └── private R2: artifact bytes
```

A deployment has four distinct, pathless HTTPS browser origins:

| Origin  | Purpose                                    | Cloudflare Access |
| ------- | ------------------------------------------ | ----------------- |
| Owner   | Owner UI/API and isolated archive previews | Required          |
| Private | Owner-authenticated artifact viewing       | Required          |
| Public  | Stable public artifact URLs                | Not enabled       |
| Share   | Secret capability-link artifacts           | Not enabled       |

All four surfaces use the same D1 database and private R2 bucket. D1 stores metadata and
lifecycle state; R2 stores artifact bytes and must not have an `r2.dev` URL or public custom
domain. Apply the packaged D1 migrations before serving traffic.

Artifacts can contain active HTML and JavaScript. Normal artifact views must never share an
origin with the owner UI or mutation API: same-origin artifact code could send owner-authorized
API requests. The archive's authenticated `/preview/assets/<asset-id>/**` route is a narrow
exception: its iframe uses an opaque sandbox origin to isolate the preview from the owner UI and
API. The preview CSP permits inline scripts and styles plus classic same-publication
assets under that artifact's own `/preview/assets/<asset-id>/` prefix, while blocking arbitrary
external subresources, fetches, forms, and frames. This is not offline execution or malware
proofing: preview code can self-navigate, and authorized agents and artifact code should still be
trusted to handle their own contents. No browser rendering service is involved. External module
graphs work on public and secret-link delivery through noncredentialed CORS. They are unsupported
for private delivery because those responses lack the CORS header module loading requires, and for
owner previews because the opaque sandbox cannot make credentialed Access requests; inline scripts
and classic same-publication assets remain supported.

General one-origin path multiplexing such as `/api`, `/private`, and `/share` on one hostname is
not supported; paths alone are not a browser security boundary.

## Source map and limits

```text
src/
|-- cli/             CLI commands, setup, connection, and publication flows
|-- worker/          Owner API, routing, delivery, privacy, and cleanup
|-- ui/              Owner archive and upload UI
|-- upload-limits.ts Shared upload/publication limits used by CLI and Worker
`-- cli.ts           CLI entrypoint
```

The current upload contract is:

| Limit                         | Value                     |
| ----------------------------- | ------------------------- |
| Maximum file size             | 25 MiB                    |
| Maximum publication size      | 100 MiB                   |
| Maximum files per publication | 500                       |
| Abandoned upload cleanup      | 24 hours without progress |

## Deployment modes

Choose one of these secure topologies:

1. **Account with a domain:** deploy one Worker with four custom hostnames, for example
   `owner.example.com`, `private.example.com`, `public.example.com`, and `share.example.com`.
   Wrangler routes with `custom_domain: true` manage custom-domain DNS and certificates during
   deployment. Disable the `workers.dev` and preview URLs so they cannot bypass hostname
   policies.
2. **Account without a domain:** deploy four distinct Worker names. Their production URLs
   become four origins such as
   `shlook-owner.<workers-subdomain>.workers.dev`,
   `shlook-private.<workers-subdomain>.workers.dev`,
   `shlook-public.<workers-subdomain>.workers.dev`, and
   `shlook-share.<workers-subdomain>.workers.dev`. Enable Access separately on the owner and
   private `workers.dev` routes; leave public and share unauthenticated.

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

`CLOUDFLARE_API_TOKEN` is preferred; `SHLOOK_CF_TOKEN` is a compatibility alias. Domain, owner
email, and optional account ID also fall back to `SHLOOK_DOMAIN`, `SHLOOK_OWNER_EMAIL`, and
`SHLOOK_ACCOUNT_ID`. The broad provisioning token must be able to verify itself; read
memberships and zones; read and write D1, R2, Access applications, Access policies, and Access
service tokens; inspect Worker services and custom domains; and deploy Worker scripts and custom
domains. Setup reports unavailable or permission-denied capability probes in its plan.

Setup stores generated runtime Access credentials in
`${XDG_CONFIG_HOME:-$HOME/.config}/shlook/auth.json`, its Wrangler configuration in
`.../shlook/deployment/wrangler.json`, and the generated encryption key in
`.../shlook/deployment/secret-encryption-key`. Owner-only deployment state also includes
`manifest.json` and, only while recovering an interrupted first apply,
`pending-service-token.json`; never print their contents. The initial deploy supplies the
encryption key through a temporary Wrangler `--secrets-file`, so setup never exposes a
route-bearing Worker without that secret.

To transfer only the runtime connection, rerun apply with `--show-connection-token` and pipe
that bearer secret to another installation without putting it in argv. For a normal SSH or
headless terminal session, run `connect` and paste the token at the hidden prompt:

```bash
shlook connect
```

For automation, pipe the token through standard input:

```bash
printf '%s\n' "$SHLOOK_CONNECTION_TOKEN" | shlook connect --json
```

The connection token contains only the deployment domain and Access service-token credentials;
it cannot provision Cloudflare. Existing environment profiles remain supported: set
`CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, and `SHLOOK_DOMAIN`, or use the four explicit
origin variables for a nonstandard topology. See
[`skills/shlook/references/setup.md`](skills/shlook/references/setup.md) for details and the
manual no-domain deployment.

## Wrangler configuration

The tracked `wrangler.jsonc` is a placeholder template (`example.com` origins, zeroed database
ID). It is safe to commit and is what `pnpm run ci` uses for its Wrangler dry-run build. Real
per-operator values are never committed: each operator supplies their own account ID, database
ID, hostnames, owner email, and secrets.

Manual deploys use the gitignored local `.wrangler.deploy.jsonc` (same shape as
`examples/wrangler.custom-domains.jsonc`, but with your real values):

```bash
pnpm deploy
```

`shlook setup` instead generates its own config at
`${XDG_CONFIG_HOME:-$HOME/.config}/shlook/deployment/wrangler.json` and deploys from there, so
manual config is only needed if you deploy without setup.

Never commit real account or database IDs, owner emails, or secrets. `SHLOOK_SECRET_ENCRYPTION_KEY`
is supplied via setup's temporary secrets file or `wrangler secret put`, never via `vars`.
Local notes in `docs/` are also gitignored and never committed.

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

`shlook publish --json` returns `data.url` as the authenticated private viewing URL. It is not a
public or secret-link URL. For static bundles, use relative asset URLs such as `./app.js` and
`./styles.css`; do not use root-relative `/assets/...` URLs, because each delivery surface has its
own publication prefix.

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

Requirements: Node.js 24, pnpm 11.17.0, and the Playwright Chromium runtime.

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium
pnpm fmt
pnpm run ci
```

Oxlint owns linting and Oxfmt owns formatting. The quality gate is `pnpm run ci`: it runs lint,
format checking, strict TypeScript checking (including browser tests), tests, Chromium browser
regressions, and a Wrangler dry-run build.

## License

MIT. See [`LICENSE`](LICENSE).
