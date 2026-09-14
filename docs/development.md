# Development

Requirements: Node.js 24, pnpm 11.17.0, and the Playwright Chromium runtime.

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium
pnpm fmt
pnpm run ci
```

Oxlint owns linting and Oxfmt owns formatting. The quality gate is `pnpm run ci`: lint, format
checking, strict TypeScript checking, tests, Chromium browser regressions, and a Wrangler dry-run
build.
