# Security boundaries

- Require trusted HTTPS, including on LAN/Tailscale. Keep the native listener on loopback.
  Network membership and forwarded identity headers do not authenticate a user.
- Native users share a library: viewers read; publishers can modify it. Separate libraries need
  separate data directories and hostnames. Ports do not isolate cookies.
- Tokens are hashed server-side. Browser login exchanges a token for a host-only Secure/HttpOnly,
  SameSite=Lax cookie; never store the API token in browser storage.
- Sessions: 30-day idle, 90-day absolute expiry, capped by token expiry. Revocation, user disable,
  logout, and re-login invalidate associated sessions. Mutations require exact origin and CSRF checks.
- Artifact HTML uses an opaque sandbox and restrictive CSP. Never enable `allow-same-origin` or
  serve unsandboxed uploads on the app origin. This is not malware scanning or an egress guarantee.
- Cloudflare uses Access and [four separate origins](privacy.md). Native is private-only.

See [self-hosting](self-host.md) for TLS/backups and [publishing](publish.md) for format/platform limits.
