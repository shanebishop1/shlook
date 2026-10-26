---
name: shlook
description: Install and set up shlook; publish, browse, retrieve, and inspect private artifacts; and manage sharing and lifecycle. Use when asked to work with artifacts stored in shlook.
---

# shlook

Configure Shlook and publish or retrieve existing artifacts. Do not rewrite their contents.

```bash
shlook auth check --instance home --json
shlook publish ./artifact --name "Review artifact" --instance home --json
shlook verify <asset-id> --instance home --json
```

Private by default; public sharing requires explicit approval. Never put credentials in argv,
URLs, chat, or logs. Obtain approval before provisioning infrastructure.

Read only what the task needs:

| Task                              | Reference                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------- |
| Select a server or authenticate   | [Instances](references/instances.md)                                            |
| Run locally, on LAN, or Tailscale | [Self-hosting](references/self-host.md)                                         |
| Deploy to Cloudflare              | [Setup](references/setup.md)                                                    |
| Publish or retrieve               | [Publishing](references/publish.md), [commands](references/commands.md)         |
| Verify or troubleshoot            | [Verification](references/verification.md)                                      |
| Review access or sharing          | [Security](references/security.md), [Cloudflare privacy](references/privacy.md) |
