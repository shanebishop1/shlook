# Setup

Required runtime: Node.js 24 or later. Install the released CLI with
`npm install --global shlook`. In a source checkout, run `pnpm build:cli` and use
`./dist/cli.js`.

## Package values and operator values

The package owns the Worker entry point, migrations, route grammar, and binding names `DB` and
`ASSETS`. The operator owns every Cloudflare resource name, hostname, ID, credential, and
email address. Keep those values in an operator-controlled Wrangler configuration and secret
store; do not add them to package files.

Record these values before deploying:

| Value           | Example placeholder                        |
| --------------- | ------------------------------------------ |
| Account         | `<cloudflare-account-id>`                  |
| D1              | `<database-name>` and `<database-id>`      |
| R2              | `<private-bucket-name>`                    |
| Owner surface   | `<owner-worker-name>` / `<owner-host>`     |
| Private surface | `<private-worker-name>` / `<private-host>` |
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

## Manual deployment checklist

The package does not automate this checklist.

1. Authenticate Wrangler to the operator's Cloudflare account.
2. Create one D1 database and one R2 bucket. Keep R2 private: do not enable `r2.dev` or attach
   a public custom domain. Wrangler can create them with:

   ```bash
   npx wrangler d1 create <database-name>
   npx wrangler r2 bucket create <private-bucket-name>
   ```

   Copy the returned D1 ID into every database binding in `wrangler.jsonc`.

3. In the operator Wrangler configuration, bind the same database as `DB` and bucket as
   `ASSETS` for all three surfaces. Point D1 migrations at the package's `migrations/`
   directory. Set all four Worker variables in every deployment/environment:
   `SHLOOK_OWNER_ORIGIN`, `SHLOOK_PRIVATE_ORIGIN`, `SHLOOK_SHARE_ORIGIN`, and
   `SHLOOK_OWNER_EMAIL`. Wrangler `vars` and bindings do not inherit into named environments,
   so the no-domain template repeats them intentionally.
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

   # workers.dev template (the same database is shared by all three environments):
   npx wrangler d1 migrations apply <database-name> --remote --config <operator-config> --env owner
   ```

6. Deploy three isolated origins:
   - **With a domain:** route the owner, private, and share surfaces to three distinct
     hostnames. Turn off `workers.dev` and preview URLs for protected deployments.
   - **Without a domain:** deploy three distinct Worker names with `workers_dev` enabled. Use
     their three production `workers.dev` URLs as the origins.

   The packaged templates support these commands:

   ```bash
   # One Worker with three custom domains:
   npx wrangler deploy --config wrangler.jsonc

   # Three workers.dev Workers:
   npx wrangler deploy --config wrangler.jsonc --env owner
   npx wrangler deploy --config wrangler.jsonc --env private
   npx wrangler deploy --config wrangler.jsonc --env share
   ```

7. Configure Cloudflare Access only on the owner and private origins. Add an Allow policy for
   exactly `<owner-email>` and a Service Auth policy containing the agent service token. Do
   not protect the share origin with Access. In custom-domain mode, create hostname-scoped
   self-hosted Access applications for the owner and private hostnames. Do not enable the
   dashboard's Worker-wide **Protect this Worker** control on the shared Worker, because that
   would also challenge the public share hostname.
8. Give the agent the service-token credentials and all three origins:

   ```bash
   export CF_ACCESS_CLIENT_ID="<access-service-token-client-id>"
   export CF_ACCESS_CLIENT_SECRET="<access-service-token-client-secret>"
   export SHLOOK_API_ORIGIN="https://<owner-host>"
   export SHLOOK_PRIVATE_ORIGIN="https://<private-host>"
   export SHLOOK_SHARE_ORIGIN="https://<share-host>"
   ```

   Use each URL's origin only: HTTPS scheme plus hostname, with no path.

9. Assign the cleanup cron to one deployment only. Deploy, then follow `verification.md`.

## About `shlook setup`

`shlook setup --plan --json` reports the portable topology and currently supplied origins; it
is not a remote Cloudflare discovery or provisioning tool. `shlook setup --apply --json`
refuses mutation and points back to this checklist. Use an operator-owned configuration so an
installed package can never deploy another operator's account, resource IDs, or hostnames.
