# Security model

The main path is deliberately small:

```text
shlook CLI --Access service token--> Owner origin / owner API
                                       |-- D1: metadata and lifecycle state
                                       +-- private R2: artifact bytes
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
[privacy reference](../skills/shlook/references/privacy.md) for visibility, capability, and expiry
boundaries.

## Setup and routes

The skill's [setup reference](../skills/shlook/references/setup.md) covers released CLI installation,
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
[verification reference](../skills/shlook/references/verification.md) after publication and after
visibility or lifecycle changes.
