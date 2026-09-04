# Setup

Required runtime: Node.js 24 or later. Install the released CLI with
`npm install --global shlook`. In a source checkout, run `pnpm build:cli` and use
`./dist/cli.js`.

## Package values and operator values

The package owns the Worker entry point, migrations, route grammar, and binding names `DB` and
`ASSETS`. Automated custom-domain setup also uses the fixed resource names `shlook` for the D1
database, Worker, and Access service token, `shlook-assets` for R2, and `shlook-owner` and
`shlook-private` for Access applications. The operator owns the account, domain, email, IDs, and
credentials. Manual deployments may choose their resource names.

Record these values before deploying:

| Value           | Example placeholder                        |
| --------------- | ------------------------------------------ |
| Account         | `<cloudflare-account-id>`                  |
| D1              | `<database-name>` and `<database-id>`      |
| R2              | `<private-bucket-name>`                    |
| Owner surface   | `<owner-worker-name>` / `<owner-host>`     |
| Private surface | `<private-worker-name>` / `<private-host>` |
| Public surface  | `<public-worker-name>` / `<public-host>`   |
| Share surface   | `<share-worker-name>` / `<share-host>`     |
| Human identity  | `<owner-email>`                            |
| Agent identity  | `<access-service-token-id>` and secret     |
| Secret recovery | 32 random bytes, base64 encoded            |

Create a dedicated operator directory and install the package locally so Wrangler can resolve
the package-owned Worker and migrations:

```bash
mkdir shlook-deploy && cd shlook-deploy
npm init -y
npm install shlook
cp node_modules/shlook/examples/wrangler.custom-domains.jsonc wrangler.jsonc
# Or, without a domain:
cp node_modules/shlook/examples/wrangler.workers-dev.jsonc wrangler.jsonc
```

Replace every angle-bracket placeholder before running Wrangler. Never edit the installed
package under `node_modules`.

## Headless custom-domain setup

Setup needs no browser, Wrangler login, OAuth, or interactive prompt. Use a temporary Cloudflare
API token for provisioning:

```bash
export CLOUDFLARE_API_TOKEN="<temporary-provisioning-token>"
shlook setup --plan --domain "example.com" --owner-email "owner@example.com" --json
shlook setup --apply --domain "example.com" --owner-email "owner@example.com" --json
```

Add `--adopt-existing` to plan and apply only when intentionally taking ownership of colliding
pre-existing resources with setup's fixed names. Fresh setup is safe without it, and subsequent
runs use the persisted ownership manifest rather than requiring adoption again.

`CLOUDFLARE_API_TOKEN` is preferred; `SHLOOK_CF_TOKEN` is an alias. If both are set to different
values, setup stops. `--domain`, `--owner-email`, and optional `--account-id` fall back to
`SHLOOK_DOMAIN`, `SHLOOK_OWNER_EMAIL`, and `SHLOOK_ACCOUNT_ID`. The provisioning token must permit
the exact API surfaces setup probes or mutates:

- token verification, account membership read, and zone read;
- account D1 database read/write and R2 bucket read/write;
- account Access application, application-policy, and service-token read/write;
- account Workers service read and Worker script deployment; and
- account Workers custom-domain read/write for the selected zone.

Plan verifies the token, discovers existing resources without mutation, and reports each missing,
rate-limited, or unavailable capability probe. Apply creates fresh resources or reuses resources
owned by its manifest, writes the deployment configuration, applies D1 migrations, and deploys
the Worker and four custom domains with `SHLOOK_SECRET_ENCRYPTION_KEY` supplied in the same initial
deployment through a temporary owner-only Wrangler `--secrets-file`. This prevents exposing a
route-bearing incomplete Worker. Apply then verifies owner and private Access and stores the
generated runtime connection. The broad provisioning token is passed only
to the setup operations and a restricted Wrangler child environment; it is never persisted.

Setup writes mode-restricted files below `${XDG_CONFIG_HOME:-$HOME/.config}/shlook`:

```text
auth.json                         generated Access service token and domain
deployment/wrangler.json         generated deployment IDs and configuration
deployment/secret-encryption-key generated runtime encryption secret
deployment/manifest.json         deployment ownership and resource IDs
deployment/pending-service-token.json interrupted-apply recovery (temporary)
```

These files and directories are owner-only. The manifest contains no service-token secret. The
pending file can contain one-time Access credentials and is removed after the connection is
verified and stored; inspect paths and metadata only, never print secret-bearing contents.

The generated Access service token lasts exactly 90 days (2160 hours) and is artifact/runtime
authentication only; it cannot provision Cloudflare. Apply stores it automatically and omits a
transferable token from normal output. Use `--show-connection-token` only when a second
installation needs to connect, treat the result as a bearer secret, and deliver it through stdin
rather than argv:

```bash
printf '%s\n' "$SHLOOK_CONNECTION_TOKEN" | shlook connect --json
```

`connect` verifies the owner health endpoint before writing `auth.json`. Existing environment
profiles remain compatible and take precedence when any profile variable is set: provide
`CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, and `SHLOOK_DOMAIN`, or both Access credentials
and all four explicit origin variables. Partial profiles fail rather than borrowing stored values.

Rerunning apply reuses manifest-owned resources only when their identity and configuration match
exactly, then reapplies migrations, redeploys with the persisted encryption key, verifies, and
refreshes local auth. An interrupted first apply recovers one-time service-token credentials from
the owner-only pending file instead of creating a duplicate. Setup never automatically renews or
duplicates a service token: an expired token is a conflict, and a token expiring within seven
days causes plan to report a blocked action and apply to stop. Renewal is not part of the setup
flow and must be handled explicitly. Unowned fixed-name collisions stop unless intentional
adoption is requested.

## Manual deployment checklist

Use this checklist for no-domain or other nonstandard deployments.

1. Authenticate Wrangler to the operator's Cloudflare account.
2. Create one D1 database and one R2 bucket. Keep R2 private: do not enable `r2.dev` or attach
   a public custom domain. Wrangler can create them with:

   ```bash
   npx wrangler d1 create <database-name>
   npx wrangler r2 bucket create <private-bucket-name>
   ```

   Copy the returned D1 ID into every database binding in `wrangler.jsonc`.

3. In the operator Wrangler configuration, bind the same database as `DB` and bucket as
   `ASSETS` for all four surfaces. Point D1 migrations at the package's `migrations/`
   directory. Set all five Worker variables in every deployment/environment:
   `SHLOOK_OWNER_ORIGIN`, `SHLOOK_PRIVATE_ORIGIN`, `SHLOOK_PUBLIC_ORIGIN`,
   `SHLOOK_SHARE_ORIGIN`, and `SHLOOK_OWNER_EMAIL`. Wrangler `vars` and bindings do not inherit
   into named environments, so the no-domain template repeats them intentionally.
4. Generate the secret-link encryption key without printing it and store it as a Worker secret.
   The custom-domain topology needs it on the shared Worker; the no-domain topology needs it
   only on the owner Worker:

   ```bash
   # Custom-domain template:
   openssl rand -base64 32 | npx wrangler secret put SHLOOK_SECRET_ENCRYPTION_KEY --config <operator-config>

   # workers.dev template:
   openssl rand -base64 32 | npx wrangler secret put SHLOOK_SECRET_ENCRYPTION_KEY --config <operator-config> --env owner
   ```

   Back up this key in the operator's secret manager. Losing or rotating it makes existing
   encrypted capability URLs unrecoverable in the owner UI; share validation still uses their
   hashes until each capability is rotated or revoked.

5. Apply all D1 migrations remotely before deployment:

   ```bash
   # Custom-domain template:
   npx wrangler d1 migrations apply <database-name> --remote --config <operator-config>

   # workers.dev template (the same database is shared by all four environments):
   npx wrangler d1 migrations apply <database-name> --remote --config <operator-config> --env owner
   ```

6. Deploy four isolated, pathless HTTPS origins:
   - **With a domain:** deploy one Worker with four distinct custom hostnames for the owner,
     private, public, and share surfaces. Routes configured with `custom_domain: true` make
     Wrangler manage the custom-domain DNS and certificates at deploy. Turn off the Worker's
     `workers.dev` and preview URLs.
   - **Without a domain:** deploy four distinct Worker names with `workers_dev` enabled. Use
     their four production `workers.dev` URLs as the origins. All four Workers share D1 and R2.

   The packaged templates support these commands:

   ```bash
   # One Worker with four custom domains:
   npx wrangler deploy --config wrangler.jsonc

   # Four workers.dev Workers:
   npx wrangler deploy --config wrangler.jsonc --env owner
   npx wrangler deploy --config wrangler.jsonc --env private
   npx wrangler deploy --config wrangler.jsonc --env public
   npx wrangler deploy --config wrangler.jsonc --env share
   ```

7. Configure Cloudflare Access only on the owner and private origins. Add an Allow policy for
   exactly `<owner-email>` and a Service Auth policy containing the agent service token. Keep
   the public and share origins intentionally outside Access; their hosts accept only direct
   public paths and capability paths, respectively. In custom-domain mode, create
   hostname-scoped self-hosted Access applications for the owner and private hostnames. Do not
   enable the dashboard's Worker-wide **Protect this Worker** control on the shared Worker,
   because that would also challenge the public and share hostnames.
8. Give the agent the service-token credentials and the base domain:

```bash
export CF_ACCESS_CLIENT_ID="<access-service-token-client-id>"
export CF_ACCESS_CLIENT_SECRET="<access-service-token-client-secret>"
export SHLOOK_DOMAIN="<domain>"
```

The CLI derives `shlook`, `private`, `public`, and `share` hostnames from that domain. For a
nonstandard topology, override any derived address with `SHLOOK_API_ORIGIN`,
`SHLOOK_PRIVATE_ORIGIN`, `SHLOOK_PUBLIC_ORIGIN`, or `SHLOOK_SHARE_ORIGIN`. Override values must
be distinct HTTPS origins with no path.

9. Assign the cleanup cron to one deployment only. Deploy, then follow `verification.md`.
