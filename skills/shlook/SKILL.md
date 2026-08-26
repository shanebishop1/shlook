---
name: shlook
description: Publish completed HTML, static sites, and raster images to private-by-default shlook hosting, then manage sharing and lifecycle.
---

# shlook

Use the `shlook` CLI to publish an existing completed artifact. Do not generate,
rewrite, or infer artifact content in this skill.

## Default Flow

1. Run `shlook auth check --json`.
2. If infrastructure is not ready, read `references/setup.md` and run
   `shlook setup --plan --json` before any mutation.
3. Run `shlook publish <path> --json`. Publication defaults private.
4. Run `shlook verify <asset-id> --json` to verify live owner metadata and the
   authenticated private URL. Before reporting a public or capability URL,
   perform the separate audience checks in `references/verification.md`.
5. Change visibility, create a secret link, or set expiry only when explicitly
   requested by the user.

## References

- Setup and credentials: `references/setup.md`
- Command grammar and JSON behavior: `references/commands.md`
- Visibility, capabilities, and expiry: `references/privacy.md`
- Verification and troubleshooting: `references/verification.md`

Never print Access client secrets, Cloudflare API tokens, or recovered capability
hashes. A newly created or rotated capability is plaintext only in that explicit
command's one-time response.
