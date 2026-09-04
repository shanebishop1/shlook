---
name: shlook
description: Publish completed HTML, static sites, and raster images to a self-hosted, private-by-default shlook deployment, then manage sharing and lifecycle.
---

# shlook

Use the `shlook` CLI to publish an existing completed artifact. Do not generate, rewrite, or
infer artifact content in this skill.

## Default Flow

1. Require `SHLOOK_DOMAIN` plus the agent's Cloudflare Access service-token credentials. The CLI
   derives the four standard Shlook origins. Use individual origin environment variables only to
   override a nonstandard topology.
2. Run `shlook auth check --json`.
3. If infrastructure is not ready, stop and read `references/setup.md`. Setup is an
   operator-owned manual process; do not claim that `shlook setup` provisions Cloudflare.
4. Choose a concise, human-readable asset name and run
   `shlook publish <path> --name "<short name>" [--description "<what it is>"] --json`.
   Publication defaults private.
5. Run `shlook verify <asset-id> --json` to verify owner metadata and the authenticated private
   URL. Before reporting a public or capability URL, perform the separate audience checks in
   `references/verification.md`.
6. Change visibility, create a secret link, or set expiry only when explicitly requested.

## References

- Setup and credentials: `references/setup.md`
- Command grammar and JSON behavior: `references/commands.md`
- Visibility, capabilities, and expiry: `references/privacy.md`
- Verification and troubleshooting: `references/verification.md`

Never print Access client secrets, Cloudflare API tokens, or recovered capability hashes. A
newly created or rotated capability is plaintext only in that explicit command's one-time
response.
