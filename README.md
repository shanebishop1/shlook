# shlook

[![npm version](https://img.shields.io/npm/v/shlook.svg)](https://www.npmjs.com/package/shlook)
[![CI](https://github.com/shanebishop1/shlook/actions/workflows/ci.yml/badge.svg)](https://github.com/shanebishop1/shlook/actions/workflows/ci.yml)

`shlook` is a self-hosted Cloudflare publication pipeline for agent-created HTML, static sites,
and raster images. The CLI and owner UI send artifacts to an owner-authenticated API;
publications remain private until an operator explicitly enables public or secret-link sharing.

![shlook demo](docs/assets/shlook_demo.gif)

### Key capabilities

- Browser-free CLI setup, connection, publication, and lifecycle workflows.
- An owner archive and API backed by D1 metadata/lifecycle state and private R2 bytes.
- Separate private, public, and capability-link delivery surfaces for untrusted artifacts.
- Plan/apply provisioning with operator-owned Wrangler configuration and short-lived credentials.

## Quick start

Install the skill for your coding agent:

```bash
npx skills add shanebishop1/shlook
```

Then paste this prompt into your agent (restart it first if needed to load the new skill):

```text
Use the shlook skill to install and set up the shlook tool
(https://github.com/shanebishop1/shlook) for me. Follow the skill's setup
reference, check prerequisites, and handle the CLI installation and deployment.
Ask me for any missing Cloudflare account, domain, or owner-email details,
and guide me through securely providing a temporary provisioning token without
pasting secrets into chat. Show me the deployment plan and get my approval
before applying it. Verify the connection when finished, keep publications
private by default, and tell me how to publish my first artifact.
```

You'll need Node.js/npm to run the skill installer and a Cloudflare account for hosting.
The agent can check the CLI's Node.js 24+ requirement and guide any prerequisite setup.
With a domain managed by Cloudflare, deployment is automated; without one, the skill includes
a manual deployment checklist the agent can follow. You provide account access and approvals;
the agent handles the commands. The temporary provisioning token is never persisted by shlook.

For direct CLI setup and credential details, see the
[setup reference](skills/shlook/references/setup.md).

## Security model

The main path is deliberately small:

```text
shlook CLI --Access service token--> Owner origin / owner API
                                       ├── D1: metadata and lifecycle state
                                       └── private R2: artifact bytes
```

Each deployment uses four distinct, pathless HTTPS origins:

| Origin  | Purpose                                    | Access   |
| ------- | ------------------------------------------ | -------- |
| Owner   | Owner UI/API and isolated archive previews | Required |
| Private | Owner-authenticated artifact viewing       | Required |
| Public  | Stable public artifact URLs                | Off      |
| Share   | Secret capability-link artifacts           | Off      |

R2 stores the artifact bytes and must remain private: do not enable an `r2.dev` URL or public
custom domain. All surfaces use the same D1 database and R2 bucket; apply packaged migrations
before serving traffic. Paths alone are not a browser security boundary, so one-origin path
multiplexing such as `/api`, `/private`, and `/share` is unsupported.

Artifacts can contain active HTML and JavaScript. Owner archive previews are live HTML in an
opaque sandboxed iframe, not screenshots or malware scanning. Preview CSP supports inline
scripts/styles and classic same-publication assets while blocking arbitrary external subresources,
fetches, forms, and frames. Preview code can self-navigate, so authorized agents and artifact
code should still be trusted with their own contents. External module graphs work on public and
secret-link delivery through noncredentialed CORS, but are unsupported for private delivery and
owner previews.

Every new artifact is private. Do not choose public or secret-link visibility without explicit
intent, treat asset IDs as non-secret, and never put capability URLs in public logs. See the
[privacy reference](skills/shlook/references/privacy.md) for visibility, capability, and expiry
boundaries.

## Archive and limits

Archive search filters the current page of up to 24 artifacts by name, description, ID, or
visibility. Pagination is separate; searching does not change the server-side page or filtering
behavior.

| Limit                         | Value                     |
| ----------------------------- | ------------------------- |
| Maximum file size             | 25 MiB                    |
| Maximum publication size      | 100 MiB                   |
| Maximum files per publication | 500                       |
| Abandoned upload cleanup      | 24 hours without progress |

## Publish an artifact

Every new publication has a concise display name and may have a description:

```bash
shlook publish ./artifact \
  --name "Owner archive refinement" \
  --description "Responsive archive controls and theme study" \
  --json
```

Names accept 1-80 characters; descriptions accept up to 500. Both are stored in D1, returned by
the owner API, and shown and searched in the owner archive. Publication defaults to private.
`shlook publish --json` returns `data.url` as the authenticated private viewing URL, not a public
or secret-link URL. Static bundles should use relative asset URLs such as `./app.js` and
`./styles.css`, not root-relative `/assets/...` URLs.

The creation API accepts the same metadata as JSON:

```json
{
  "name": "Owner archive refinement",
  "description": "Responsive archive controls and theme study"
}
```

For command grammar, JSON behavior, and environment-profile rules, see the
[commands reference](skills/shlook/references/commands.md).

## Setup and routes

The skill's [setup reference](skills/shlook/references/setup.md) covers released CLI installation,
headless custom-domain setup, the manual no-domain deployment checklist, Wrangler values,
credential storage, Access policies, migrations, and secret handling. Setup uses a temporary
provisioning token; never commit real account/database IDs, owner emails, or secrets. The
generated runtime connection is artifact authentication only and cannot provision Cloudflare.

Each host has its own route surface:

- Owner: `/`, `/archive`, `/health`, and `/api/assets...`
- Private: `/latest[/<artifact-path>]` and `/assets/<asset-id>[/<artifact-path>]`
- Public: `/assets/<asset-id>[/<artifact-path>]`
- Share: `/s/<capability>/assets/<asset-id>[/<artifact-path>]`

Entrypoint aliases redirect to the actual file path so nested relative resources resolve correctly.
`/latest` pins that navigation to the current artifact ID. Use CLI 0.2.6+ to verify these redirects.

Unknown routes and artifacts unavailable to the requested audience return `404`. Follow the
[verification reference](skills/shlook/references/verification.md) after publication and after
visibility or lifecycle changes.

## Development

Requirements: Node.js 24, pnpm 11.17.0, and the Playwright Chromium runtime.

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium
pnpm fmt
pnpm run ci
```

Oxlint owns linting and Oxfmt owns formatting. The quality gate is `pnpm run ci`: lint, format
checking, strict TypeScript checking, tests, Chromium browser regressions, and a Wrangler dry-run
build.

## License

MIT. See [`LICENSE`](LICENSE).
