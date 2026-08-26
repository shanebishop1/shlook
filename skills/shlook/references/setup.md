# Setup

Required runtime: Node.js 24 or later.

Owner API commands require:

- `CF_ACCESS_CLIENT_ID`
- `CF_ACCESS_CLIENT_SECRET`

`SHLOOK_API_ORIGIN` may override `https://show.shane-bishop.com` for a controlled
environment. `SHLOOK_PRIVATE_ORIGIN` independently overrides
`https://private.show.shane-bishop.com` for private artifact verification.

Always start with:

```bash
shlook setup --plan --json
```

The plan is read-only and describes the Worker, D1 database, R2 bucket, three
hosts, and Access policy. Review its inspection results before applying. An
unresolved inspection is a conflict; apply refuses to run while any conflict
remains.

`shlook setup --apply --json` runs only the Wrangler version, configuration,
migrations, and Worker source shipped in the installed `shlook` package. It does
not use the caller's project or Wrangler installation. Access application, owner
policy, service-token policy, DNS, and custom-domain work remain explicitly
`blocked` until the E5 live gate is available. A blocked result is emitted as
top-level `ok:false` on stderr with exit code 2; it is not setup success.
