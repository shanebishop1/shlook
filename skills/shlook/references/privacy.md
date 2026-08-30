# Privacy

- Every new asset is private.
- Private artifacts are served only from `SHLOOK_PRIVATE_ORIGIN` and require Cloudflare
  Access.
- `public` is stable unauthenticated sharing from `SHLOOK_PUBLIC_ORIGIN` through direct
  `/assets/<asset-id>/**` routes only.
- `secret_link` uses a 256-bit capability. Its SHA-256 hash verifies share requests, while an
  AES-256-GCM copy encrypted with the operator-owned `SHLOOK_SECRET_ENCRYPTION_KEY` lets the
  authenticated owner UI display and copy the active URL later. Creation rejects an existing
  capability; rotation requires and invalidates an existing capability. Revocation clears the
  hash and encrypted recovery data and makes a secret-link asset private again. Capability
  URLs are served only from `SHLOOK_SHARE_ORIGIN` under
  `/s/<capability>/assets/<asset-id>/**`.
- Capabilities created before encrypted recovery was introduced require one final rotation;
  one-way hashes cannot reconstruct their original URLs.
- Share expiry denies public and capability access but preserves private owner access.
- Hard expiry denies all access and schedules bounded physical cleanup.
- Deletion targets exactly one asset and is logically immediate.

The owner/API, private-artifact, stable-public, and capability-share origins must be distinct,
pathless HTTPS origins. Normal untrusted artifact views must not share an origin with owner
mutations, so a one-host deployment with path prefixes is unsupported. The owner archive's
`/preview/assets/<asset-id>/**` route is limited to authenticated, noninteractive previews in an
opaque iframe sandbox; preview CSP denies connections and forms, and owner APIs reject passive
browser-resource destinations and cross-site Fetch Metadata. Owner and private require Access;
public and share are unauthenticated but isolated from each other by host and route grammar.

Do not choose public or secret-link visibility without explicit user intent. Do not place
capability URLs in public logs. Never treat an asset ID as a secret. Keep the R2 bucket private;
the public and share surfaces, not R2 itself, enforce their respective access policies.
