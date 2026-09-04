# Verification

Before testing, confirm that the resolved owner, private, public, and share addresses are four
distinct, pathless HTTPS origins. They may come from a stored connection, `SHLOOK_DOMAIN`, or the
four explicit origin variables. Confirm that R2 has no public `r2.dev` URL/custom domain and that
all D1 migrations are applied.

Run `shlook verify <asset-id> --json` after publication and after material visibility or
lifecycle changes. It performs two authenticated checks: owner metadata must report `live`,
and a `GET` of the private artifact entrypoint must succeed. It does not test public,
secret-link, expired, deleted, or unauthenticated audiences.

Use `shlook show <asset-id> --json` to confirm that `name` and optional `description` match the
values supplied at publication.

Perform audience checks separately with credentials appropriate to each audience:

- Private URL: `${SHLOOK_PRIVATE_ORIGIN}/assets/<asset-id>/`.
- Public URL: `${SHLOOK_PUBLIC_ORIGIN}/assets/<asset-id>/`.
- Private publication: authenticated private access succeeds; an unauthenticated request to
  the private origin is denied by Access; the public URL returns `404`.
- Public: the public URL loads without Access.
- Secret link: the one-time URL returned by `secret create|rotate` loads; a rotated or revoked
  capability returns `404`. Confirm the authenticated owner archive can copy the same active
  URL after reload. Never log a capability URL.
- Share expiry: share access returns `404` while private owner access remains.
- Hard expiry or deletion: all artifact access returns `404`.

Also verify the deployment boundary:

1. Owner and private origins require the configured owner identity or agent service token.
2. Public- and share-origin requests never receive an Access challenge.
3. The public origin rejects `/s/<capability>/assets/<asset-id>/**`, and the share origin rejects
   direct `/assets/<asset-id>/**`, both with `404`. Never print the capability while testing.
4. Owner `/api/**` paths are unavailable on private, public, and share origins.
5. Normal artifact paths are unavailable on the owner origin except for its documented redirect
   behavior. Authenticated `/preview/assets/<asset-id>/**` succeeds only on the owner origin and
   returns CSP with an opaque `sandbox`, `connect-src 'none'`, `form-action 'none'`, and
   `frame-ancestors 'self'`.
6. Any unused `workers.dev` and preview URLs are disabled; in no-domain mode, Access is enabled
   directly on the owner/private production `workers.dev` routes.

Troubleshooting order:

1. Run `shlook auth check --json`. If using an environment profile, check its variables without
   printing secrets; otherwise check `${XDG_CONFIG_HOME:-$HOME/.config}/shlook/auth.json` and its
   parent directory permissions.
2. `shlook auth check --json`
3. `shlook status --json`
4. `shlook show <asset-id> --json`
5. For setup failures, inspect the generated
   `${XDG_CONFIG_HOME:-$HOME/.config}/shlook/deployment/wrangler.json`, ownership manifest,
   pending-service-token path, and retained encryption-key path without printing file contents,
   then rerun `setup --plan` and report its structured capabilities, blocked actions, or error.
   A plan that is not ready is not successful setup; a service token within seven days of expiry
   blocks setup and is not renewed automatically.
6. Re-run `verify` and report the exact structured error.
