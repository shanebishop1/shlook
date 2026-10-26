# Instances and authentication

Profiles select a server; they do not synchronize libraries. Configuration:
`${XDG_CONFIG_HOME:-$HOME/.config}/shlook/config.json`.

```bash
shlook instance add home --url https://machine.example.ts.net --json
shlook connect --instance home
shlook instance default home --json
```

- Names: lowercase letters/digits, separated by hyphens.
- Selection: `--instance` → legacy Cloudflare environment → configured default → legacy `auth.json`.
- Token: `SHLOOK_API_TOKEN_HOME`; `home-lab` uses `SHLOOK_API_TOKEN_HOME_LAB`.
  Override with `instance add ... --token-env CUSTOM_VARIABLE` (`token_env` in config).
- Credentials: environment → saved profile credential → hidden interactive prompt.
  An empty or rejected environment token fails; it never silently falls back.
- Noninteractive calls without credentials fail. Only `connect` accepts a token through stdin.
- `instance list` lists profiles; `instance remove <name>` removes one without revoking server tokens.

Cloudflare profiles use an encoded connection token; native profiles use an API token.
Explicit profiles never borrow ambient Cloudflare credentials. Keep secrets out of config and logs.
