# Commands

Use `--json` for agent-consumed calls. Success uses
`{"ok":true,"command":...,"data":...}`; failure uses
`{"ok":false,"command":...,"error":...}` and a non-zero exit code.

```text
shlook auth check --json
shlook setup (--plan | --apply) [--domain <domain>] [--owner-email <email>] [--account-id <id>] [--show-connection-token] --json
printf '%s\n' '<connection-token>' | shlook connect --json
shlook status --json
shlook publish <path> --name <short-name> [--description <text>] [--entrypoint <relative-path>] --json
shlook list [--offset <n>] --json
shlook show <asset-id> --json
shlook visibility <asset-id> private|secret_link|public --json
shlook secret create|rotate|revoke <asset-id> --json
shlook share expiry <asset-id> <ISO-date|none> --json
shlook hard expiry <asset-id> <ISO-date|none> --json
shlook delete <asset-id> --json
shlook verify <asset-id> --json
```

Setup requires exactly one of `--plan` and `--apply`, no positional arguments, and a domain and
owner email. Those values fall back to `SHLOOK_DOMAIN` and `SHLOOK_OWNER_EMAIL`; account ID is
optional and falls back to `SHLOOK_ACCOUNT_ID`. `--show-connection-token` is apply-only. The
bootstrap credential comes from `CLOUDFLARE_API_TOKEN` (preferred) or `SHLOOK_CF_TOKEN`; if both
differ, setup fails. Plan performs remote discovery. Apply creates or reuses the standard
custom-domain resources, deploys and verifies the Worker, and stores the runtime connection.

`connect` is deliberately separate from provisioning. Its token contains only the domain and
Access service-token credentials, is a bearer secret, and must be supplied through non-TTY stdin,
never as an argv value. It verifies owner health before replacing the stored connection.

For normal commands, any of `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, `SHLOOK_DOMAIN`,
or the four explicit origin variables selects the existing environment-profile behavior. A
partial environment profile is rejected rather than completed from stored credentials. If none
is present, the CLI reads `${XDG_CONFIG_HOME:-$HOME/.config}/shlook/auth.json`.

Publish requires a human-readable name of 1-80 characters. The optional description accepts
up to 500 characters. Both values are trimmed, stored with the asset, returned by `list` and
`show`, and displayed and searched in the owner archive.

Publish accepts one HTML file, one raster image, or one static directory. It rejects symlinks,
traversal, non-regular files, missing entrypoints, and more than 500 files. A directory defaults
to `index.html`; a single file uses its filename.
