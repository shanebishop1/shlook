# Verification

Before testing, confirm that `SHLOOK_API_ORIGIN`, `SHLOOK_PRIVATE_ORIGIN`, and
`SHLOOK_SHARE_ORIGIN` are three different HTTPS origins. Confirm that R2 has no public
`r2.dev` URL/custom domain and that all D1 migrations are applied.

Run `shlook verify <asset-id> --json` after publication and after material visibility or
lifecycle changes. It performs two authenticated checks: owner metadata must report `live`,
and a `GET` of the private artifact entrypoint must succeed. It does not test public,
secret-link, expired, deleted, or unauthenticated audiences.

Perform audience checks separately with credentials appropriate to each audience:

- Private URL: `${SHLOOK_PRIVATE_ORIGIN}/assets/<asset-id>/`.
- Public URL: `${SHLOOK_SHARE_ORIGIN}/assets/<asset-id>/`.
- Private publication: authenticated private access succeeds; an unauthenticated request to
  the private origin is denied by Access; the public URL returns `404`.
- Public: the public URL loads without Access.
- Secret link: the one-time URL returned by `secret create|rotate` loads; a rotated or revoked
  capability returns `404`. Never reconstruct or log a capability URL.
- Share expiry: share access returns `404` while private owner access remains.
- Hard expiry or deletion: all artifact access returns `404`.

Also verify the deployment boundary:

1. Owner and private origins require the configured owner identity or agent service token.
2. Share-origin requests never receive an Access challenge.
3. Owner `/api/**` paths are unavailable on private and share origins.
4. Artifact paths are unavailable on the owner origin except for its documented redirect
   behavior.
5. Any unused `workers.dev` and preview URLs are disabled; in no-domain mode, Access is enabled
   directly on the owner/private production `workers.dev` routes.

Troubleshooting order:

1. Check all five environment variables from `setup.md` without printing secrets.
2. `shlook auth check --json`
3. `shlook status --json`
4. `shlook show <asset-id> --json`
5. Re-run `verify` and report the exact structured error.

A `shlook setup` result with status `blocked` is expected when Access or host provisioning
remains manual; it is not successful setup.
