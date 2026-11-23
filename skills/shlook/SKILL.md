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

## Publishing a report

Never publish raw Markdown for a person to read. Render it, then publish the output directory:

```bash
python3 assets/report/render.py report.md ./report-out
shlook publish ./report-out --name "Report title" --instance home --json
```

`render.py` is Python 3 standard-library only and writes `./report-out/index.html` from
`assets/report/report.html`: light and dark themes, a 52rem measure, styled tables with a sticky
header, soft code blocks, and print styles. It supports headings, paragraphs, emphasis, inline and
fenced code, nested lists, tables, blockquotes, links, and horizontal rules, and escapes source
HTML. Optional front matter sets `title`, `eyebrow`, and `date`; `--title`, `--eyebrow`, and
`--date` override it.

Read only what the task needs:

| Task                              | Reference                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------- |
| Select a server or authenticate   | [Instances](references/instances.md)                                            |
| Run locally, on LAN, or Tailscale | [Self-hosting](references/self-host.md)                                         |
| Deploy to Cloudflare              | [Setup](references/setup.md)                                                    |
| Publish or retrieve               | [Publishing](references/publish.md), [commands](references/commands.md)         |
| Verify or troubleshoot            | [Verification](references/verification.md)                                      |
| Review access or sharing          | [Security](references/security.md), [Cloudflare privacy](references/privacy.md) |
