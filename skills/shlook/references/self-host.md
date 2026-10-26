# Native self-hosting

Node.js 24.20+, SQLite, local files; no Cloudflare account required. One process per data directory.
Users share a private library. Independent libraries need separate directories and hostnames.

## Initialize and administer

Replace the example hostname with your server's HTTPS hostname:

```bash
shlook-server init --data-dir "$HOME/.local/share/shlook" --origin "https://<node>.<tailnet>.ts.net"
shlook-server user add operator --display-name "Operator" --data-dir "$HOME/.local/share/shlook"
shlook-server token issue --user operator --name laptop --role publisher --data-dir "$HOME/.local/share/shlook"
shlook-server start --data-dir "$HOME/.local/share/shlook"
```

Tokens are shown once on a local TTY; use `--token-file <new-path>` for headless issuance.
Transfer securely, then delete that file. Connect clients using [instance profiles](instances.md).

API tokens expire after 90 days by default. Set `--expires <UTC-ISO-timestamp>` for a future
expiry up to 365 days away, or explicitly choose no expiration:

```bash
shlook-server token issue --user operator --name automation --role publisher --expires none --token-file "$HOME/shlook-token-new" --data-dir "$HOME/.local/share/shlook"
```

The token file must be a new absolute path and is created with mode `0600`. Issuance and
listing report `expiresAt: null` for non-expiring tokens. These remain valid until revoked
or the user is disabled; protect and rotate them deliberately. Browser sessions still expire.

```text
shlook-server user list --data-dir <path>
shlook-server user disable <user-id> --data-dir <path>
shlook-server token list --user <user-id> --data-dir <path>
shlook-server token revoke <token-id> --data-dir <path>
shlook-server cleanup --data-dir <path>
```

The listener binds to `127.0.0.1:8789`. Keep it behind an HTTPS proxy that preserves Host.

## Tailscale and LAN HTTPS

For Tailscale, enable tailnet HTTPS and use the machine's full `.ts.net` name as `--origin`:

```bash
tailscale serve 8789
```

Confirm the reported URL matches `--origin`. Restrict tailnet ACLs; do not enable Funnel.

For LAN, resolve `shlook.home.arpa` to the server, configure that HTTPS origin, and use Caddy:

```caddyfile
shlook.home.arpa {
	tls internal
	reverse_proxy 127.0.0.1:8789
}
```

Install Caddy's root CA on each client, or use an owned domain with a trusted certificate.
For Node clients, if its CA store does not include Caddy's root, set
`NODE_EXTRA_CA_CERTS=/path/to/root.crt`; configure browser trust separately.
Never disable TLS verification. Check HTTPS and sign-in from each intended device.

Add `--alias https://other-hostname` during `init` to reach the same library through another
name. Configure DNS/proxy/certificates separately; browsers sign in separately per hostname.

## Restart, backup, and cleanup

Restart with the same data directory. To back up, stop the server and archive the whole directory:

```bash
tar -C "$HOME/.local/share" -czf "$HOME/shlook-backup.tgz" shlook
```

Keep backups private. Restore the complete directory while stopped, retain owner-only permissions,
then start and verify. Do not restore SQLite separately from artifact files.
Token revocation and user disable also invalidate associated browser sessions.
