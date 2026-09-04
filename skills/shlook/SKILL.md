---
name: shlook
description: Publish completed HTML, static sites, and raster images to a self-hosted, private-by-default shlook deployment, then manage sharing and lifecycle.
---

# shlook

Use the `shlook` CLI to publish an existing completed artifact. Do not generate, rewrite, or
infer artifact content in this skill.

## Default Flow

1. Use the stored connection created by `shlook setup` or `shlook connect`. Existing environment
   profiles remain compatible: provide the Access service-token credentials plus `SHLOOK_DOMAIN`,
   or all four explicit origins for a nonstandard topology.
2. Run `shlook auth check --json`.
3. If infrastructure is not ready, stop and read `references/setup.md`. The standard
   custom-domain setup is headless; manual deployment remains available for other topologies.
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
