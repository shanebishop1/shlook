# Development

Requirements: Node.js 24.20+, pnpm 11.17.0, Chromium.

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium
pnpm fmt
pnpm run ci
```

Use temporary server data and credentials. Native browser tests require HTTPS; loopback HTTP is
CLI-only. See [supported platforms](../skills/shlook/references/publish.md#local-path-platform-support).
