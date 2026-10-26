import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { loadPublishInput } from "./cli-files.ts";
import { maxPublicationBytes, maxUploadBytes } from "./upload-limits.ts";
import { renderSafeMarkdown } from "./markdown.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "shlook-cli-files-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function sparseFile(path: string, size: number): Promise<void> {
  await writeFile(path, "");
  await truncate(path, size);
}

test("rejects an oversized single file before reading it", async () => {
  const directory = await temporaryDirectory();
  const file = join(directory, "oversized.html");
  await sparseFile(file, maxUploadBytes + 1);

  await assert.rejects(loadPublishInput(file), /file larger than 25 MiB/);
});

test("rejects an oversized file within a directory", async () => {
  const directory = await temporaryDirectory();
  const input = join(directory, "input");
  await mkdir(input);
  await sparseFile(join(input, "oversized.bin"), maxUploadBytes + 1);

  await assert.rejects(loadPublishInput(input), /file larger than 25 MiB/);
});

test("rejects aggregate input over the publication limit", async () => {
  const directory = await temporaryDirectory();
  const input = join(directory, "input");
  await mkdir(input);
  for (let index = 0; index < 4; index += 1) {
    await sparseFile(join(input, `${index}.bin`), maxUploadBytes);
  }
  await writeFile(join(input, "regular.bin"), "x");

  await assert.rejects(
    loadPublishInput(input, "0.bin"),
    new RegExp(`exceeds ${maxPublicationBytes / (1024 * 1024)} MiB`),
  );
});

test("loads valid small input with bytes and content types", async () => {
  const directory = await temporaryDirectory();
  const input = join(directory, "input");
  await mkdir(join(input, "assets"), { recursive: true });
  await writeFile(join(input, "index.html"), "<!doctype html>");
  await writeFile(join(input, "assets", "site.css"), "body { color: green; }");

  const loaded = await loadPublishInput(input);
  loaded.files.sort((left, right) => left.path.localeCompare(right.path));
  assert.deepEqual(loaded, {
    entrypoint: "index.html",
    files: [
      {
        path: "assets/site.css",
        bytes: new TextEncoder().encode("body { color: green; }"),
        contentType: "text/css; charset=utf-8",
      },
      {
        path: "index.html",
        bytes: new TextEncoder().encode("<!doctype html>"),
        contentType: "text/html; charset=utf-8",
      },
    ],
  });
});

test("renders only the conservative Markdown subset and escapes active syntax", () => {
  const rendered = renderSafeMarkdown(
    '# Heading\n\nA <script>alert("x")</script> [remote](https://example.com)\n\n- first\n- second\n\n```html\n<img src=x onerror=alert(1)>\n```',
  );
  assert.match(rendered, /<h1>Heading<\/h1>/);
  assert.match(rendered, /<ul>\n<li>first<\/li>\n<li>second<\/li>\n<\/ul>/);
  assert.match(rendered, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(rendered, /\[remote\]\(https:\/\/example\.com\)/);
  assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(rendered, /<script|<img|href=/i);
});

test("converts a single Markdown file to deterministic UTF-8 HTML and rejects MDX", async () => {
  const directory = await temporaryDirectory();
  const markdown = join(directory, "notes.md");
  await writeFile(markdown, "# Café\n\n- one", "utf8");
  const first = await loadPublishInput(markdown);
  const second = await loadPublishInput(markdown);
  assert.equal(first.entrypoint, "notes.md.html");
  assert.deepEqual(first, second);
  assert.match(new TextDecoder().decode(first.files[0].bytes), /<h1>Café<\/h1>/);
  assert.equal(first.files[0].contentType, "text/html; charset=utf-8");
  await writeFile(join(directory, "unsafe.mdx"), "<script />");
  await assert.rejects(loadPublishInput(join(directory, "unsafe.mdx")), /MDX/);
  await assert.rejects(loadPublishInput(markdown, "notes.md"), /entrypoint must equal/);

  const expanding = join(directory, "expanding.md");
  await writeFile(expanding, "<".repeat(7 * 1024 * 1024));
  await assert.rejects(
    loadPublishInput(expanding),
    /generated Markdown HTML is larger than 25 MiB/,
  );
});

test("rejects symlinked input paths and children without following them", async () => {
  const directory = await temporaryDirectory();
  const outside = await temporaryDirectory();
  const file = join(outside, "outside.html");
  const root = join(directory, "input");
  await writeFile(file, "outside");
  await symlink(file, join(directory, "file-link.html"));
  await assert.rejects(loadPublishInput(join(directory, "file-link.html")));
  await symlink(outside, join(directory, "ancestor-link"));
  await assert.rejects(loadPublishInput(join(directory, "ancestor-link", "outside.html")));
  await mkdir(root);
  await symlink(outside, join(root, "escape"));
  await assert.rejects(loadPublishInput(root), /ELOOP|symlink|publish input/i);
});
