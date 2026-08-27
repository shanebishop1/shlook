# Commands

Use `--json` for agent-consumed calls. Success uses
`{"ok":true,"command":...,"data":...}`; failure uses
`{"ok":false,"command":...,"error":...}` and a non-zero exit code.

```text
shlook auth check --json
shlook setup --plan|--apply --json
shlook status --json
shlook publish <path> [--entrypoint <relative-path>] --json
shlook list [--offset <n>] --json
shlook show <asset-id> --json
shlook visibility <asset-id> private|secret_link|public --json
shlook secret create|rotate|revoke <asset-id> --json
shlook share expiry <asset-id> <ISO-date|none> --json
shlook hard expiry <asset-id> <ISO-date|none> --json
shlook delete <asset-id> --json
shlook verify <asset-id> --json
```

`setup --plan` only reports packaged assumptions. `setup --apply` does not create D1 or R2,
DNS/custom domains, three Worker names, Access applications or policies, or service tokens;
use the manual operator checklist in `setup.md`.

Publish accepts one HTML file, one raster image, or one static directory. It
rejects symlinks, traversal, non-regular files, missing entrypoints, and more than
500 files. A directory defaults to `index.html`; a single file uses its filename.
