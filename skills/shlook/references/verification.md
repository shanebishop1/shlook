# Verification

Run `shlook verify <asset-id> --json` after publication and after material
visibility or lifecycle changes. This command performs exactly two authenticated
checks: owner metadata must report `live`, and a `GET` of the private artifact
entrypoint must succeed. It does not test public, secret-link, expired, deleted,
or unauthenticated audiences.

Perform intended-audience checks separately, using a client with the credentials
appropriate to that audience, and record those results independently:

- Private: unauthenticated share-host access returns `404`.
- Public: the stable share URL loads without Access.
- Secret link: the current capability loads; a rotated or revoked capability
  returns `404`.
- Share expiry: share access returns `404` while private owner access remains.
- Hard expiry or deletion: all access returns `404`.

Troubleshooting order:

1. `shlook auth check --json`
2. `shlook status --json`
3. `shlook show <asset-id> --json`
4. Re-run `verify` and report the exact structured error.

Do not expose credentials while diagnosing. A setup response with status
`blocked` requires completion of the named Access or live-infrastructure step.
