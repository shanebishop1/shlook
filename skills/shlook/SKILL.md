---
name: shlook
description: Install and set up shlook; publish, browse, retrieve, and inspect private artifacts; and manage sharing and lifecycle. Use when asked to work with artifacts stored in shlook.
---

# shlook

Use this skill to install and configure `shlook`, publish an existing completed artifact, or access
artifacts in its private library. Do not generate, rewrite, or infer artifact content in this skill.

## Installation and Setup

For installation or setup requests, read `references/setup.md` before running CLI commands.
The skill installer installs these instructions, not the shlook CLI or Cloudflare infrastructure.

1. Check Node.js 24+ and platform requirements, then install the released CLI as documented.
   Help resolve missing prerequisites rather than assuming the CLI is already available.
2. Ask for missing Cloudflare account, domain, and owner-email details. Guide the operator through
   supplying a temporary token with the documented permissions via a secure local environment or
   secret manager, never by pasting it into chat or printing it in command output.
3. For a Cloudflare-managed domain, run setup with `--plan`, summarize the proposed changes, and
   obtain approval before `--apply`. Do not adopt colliding resources without explicit approval.
   Without a domain, follow the manual deployment checklist instead; automated setup is for
   custom domains only.
4. Run `shlook auth check --json` after setup. Report the owner URL and verification result,
   explain how to publish an existing artifact, and remind the operator to revoke the temporary
   provisioning token when setup is complete. Do not publish or enable sharing just to finish setup.

## Default Flow

1. Use the stored connection created by `shlook setup` or `shlook connect`. Existing environment
   profiles remain compatible: provide the Access service-token credentials plus `SHLOOK_DOMAIN`,
   or all four explicit origins for a nonstandard topology.
2. Run `shlook auth check --json`.
3. If infrastructure is not ready, stop and read `references/setup.md`. The standard
   custom-domain setup is headless; use `--adopt-existing` only for intentional adoption of
   colliding fixed-name resources. Manual deployment remains available for other topologies.
4. Choose a concise, human-readable asset name and run
   `shlook publish <path> --name "<short name>" [--description "<what it is>"] --json`.
   Publication defaults private. The JSON `data.url` is the authenticated private viewing URL,
   not a public or secret-link URL. Static bundles must use relative asset URLs, not root-relative
   `/assets/...` URLs.
5. Run `shlook verify <asset-id> --json` to verify owner metadata and the authenticated private
   URL. Before reporting a public or capability URL, perform the separate audience checks in
   `references/verification.md`; do not make an artifact public to work around private delivery
   limits.
6. Change visibility, create a secret link, or set expiry only when explicitly requested.

## Retrieve Artifacts

1. Run `shlook auth check --json`, then `shlook list --json` to find the asset. Use
   `shlook show <asset-id> --json` when its metadata is needed.
2. Fetch `${SHLOOK_PRIVATE_ORIGIN}/assets/<asset-id>/` with the configured Cloudflare Access
   service-token credentials and save the response locally. Accept only the canonical `302` to a
   file under the same private origin and asset ID, then fetch that file with the same credentials.
3. Inspect the saved artifact with the appropriate local tool. For relative files referenced by an
   HTML entrypoint, fetch them from the same asset path with the same credentials.
4. Never print credentials, use an unauthenticated fetcher for a private URL, or change visibility
   merely to retrieve an artifact.

Owner archive previews are live HTML in opaque sandboxed iframes, not browser-rendered screenshots
or malware scanning. Inline scripts/styles and classic same-publication assets are supported;
the preview CSP blocks arbitrary external subresources, fetches, forms, and frames. External
module graphs are supported on public and secret-link delivery through noncredentialed CORS, but
not on private delivery or owner previews. Preview code can self-navigate, so authorized agents
and artifact code should still be trusted with their own contents.

## References

- Setup and credentials: `references/setup.md`
- Command grammar and JSON behavior: `references/commands.md`
- Visibility, capabilities, and expiry: `references/privacy.md`
- Verification and troubleshooting: `references/verification.md`

Never print Access client secrets, Cloudflare API tokens, or recovered capability hashes. A
newly created or rotated capability is plaintext only in that explicit command's one-time
response.
