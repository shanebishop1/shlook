# Privacy

- Every new asset is private.
- Private artifacts are served only from `SHLOOK_PRIVATE_ORIGIN` and require Cloudflare
  Access.
- `public` is stable unauthenticated sharing from `SHLOOK_SHARE_ORIGIN`.
- `secret_link` uses a 256-bit capability returned once when created or rotated. Creation
  rejects an existing capability; rotation requires and invalidates an existing capability.
  Revocation makes a secret-link asset private again.
- Share expiry denies public and capability access but preserves private owner access.
- Hard expiry denies all access and schedules bounded physical cleanup.
- Deletion targets exactly one asset and is logically immediate.

The owner/API, private-artifact, and share origins must remain distinct. Untrusted active
artifact content must not share an origin with owner mutations, so a one-host deployment with
path prefixes is unsupported.

Do not choose public or secret-link visibility without explicit user intent. Do not place
capability URLs in public logs. Never treat an asset ID as a secret. Keep the R2 bucket private;
the share Worker, not R2 itself, enforces public and capability access.
