# Privacy

- Every new asset is private.
- `public` is stable, unauthenticated sharing on `share.shane-bishop.com`.
- `secret_link` uses a 256-bit capability returned once when created or rotated.
- Creation rejects an asset that already has a capability. Rotation requires an
  existing capability and invalidates it. Revocation makes a secret-link asset
  private again.
- Share expiry denies public and capability access but preserves private owner
  access.
- Hard expiry denies all access and schedules bounded physical cleanup.
- Deletion targets exactly one asset and is logically immediate.

Do not choose public or secret-link visibility without explicit user intent. Do
not place capability URLs in public logs. Never treat an asset ID as a secret.
