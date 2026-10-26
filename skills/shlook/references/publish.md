# Publishing and Markdown

```bash
shlook publish ./artifact --name "Review" --instance home --json
shlook verify <asset-id> --instance home --json
```

- Inputs: HTML, raster image, static directory, or a single `.md` file. Directories default to `index.html`.
- Markdown supports headings, paragraphs, lists, and fenced code. Raw HTML is escaped;
  links/images stay text. Directory Markdown stays text; no MDX.
- Native bundles embed local classic JS/CSS, raster images, and fonts in sandboxed HTML.
  Modules, frames, CSS imports, and deferred external classic scripts are unsupported. Runtime
  fetch/XHR and external embedded resources are blocked, but links and self-navigation are not
  egress controls.
- Limits: 25 MiB/file, 100 MiB/publication, 500 files. Reject symlinks and traversal.
- Native is private-only. Cloudflare also supports explicit [public/secret sharing](privacy.md).

## Local-path platform support

Local-path publishing supports macOS and Linux on Node.js 24.20+.
