# Publishing and Markdown

```bash
shlook publish ./artifact --name "Review" --instance home --json
shlook verify <asset-id> --instance home --json
```

- Inputs: HTML, raster image, static directory, or a single `.md` file. Directories default to `index.html`.
- Markdown supports headings, paragraphs, lists, and fenced code. Raw HTML is escaped;
  links/images stay text. Directory Markdown stays text; no MDX.
- Native bundles embed local classic JS/CSS, raster images, and fonts in sandboxed HTML.
  No modules, frames, external resources, CSS imports, or runtime network access.
- Limits: 25 MiB/file, 100 MiB/publication, 500 files. Reject symlinks and traversal.
- Native is private-only. Cloudflare also supports explicit [public/secret sharing](privacy.md).

## Local-path platform support

Local-path publishing requires descriptor-relative filesystem access. Verified on Linux/arm64,
Node 24; currently fails closed on macOS. This affects both backends, not browser uploads or
profile commands. Do not bypass the file-safety guard.
