import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { loadPublishInput } from "./cli-files.ts";
import { publishFilesystem } from "./cli-filesystem.ts";
import type { InputHandle } from "./cli-filesystem.ts";
import { maxPublicationBytes, maxUploadBytes, maxUploadFiles } from "./upload-limits.ts";
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

test("enumerates complete descriptor directory streams across record sizes and repeated reads", async () => {
  const directory = await temporaryDirectory();
  const names = ["index.html", "x", `${"a".repeat(240)}.txt`, "画像.png"];
  for (const name of names) await writeFile(join(directory, name), name);
  const handle = await publishFilesystem.openRoot(directory);
  try {
    // Exercise the real fdopendir/readdir pair. Short first records catch mixed
    // inode ABIs; varied lengths check bounded decoding, not a fixed struct copy.
    for (let index = 0; index < 2; index += 1) {
      assert.deepEqual((await publishFilesystem.entries(handle)).sort(), [...names].sort());
    }
  } finally {
    await handle.close();
  }
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

test("loads single HTML and raster files, including the trusted macOS /var alias", async () => {
  const directory = await temporaryDirectory();
  for (const [name, contentType] of [
    ["index.html", "text/html; charset=utf-8"],
    ["image.png", "image/png"],
  ]) {
    const path = join(directory, name);
    const bytes = new Uint8Array([0, 1, 127, 255]);
    await writeFile(path, bytes);
    const input = process.platform === "darwin" ? path.replace(/^\/private\/var\//, "/var/") : path;
    const loaded = await loadPublishInput(input);
    assert.deepEqual(loaded, { entrypoint: name, files: [{ path: name, bytes, contentType }] });
  }
});

test("rejects NUL input components instead of truncating native C paths", async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, "index.html");
  await writeFile(path, "must not be published");
  await assert.rejects(loadPublishInput(`${path}\0ignored.html`), /unsafe path component/);
});

test("preserves distinct BOM-prefixed filenames and their bytes", async () => {
  const directory = await temporaryDirectory();
  const expected = {
    "index.html": "ordinary",
    "\uFEFFindex.html": "BOM-prefixed filename",
  };
  for (const [name, contents] of Object.entries(expected)) {
    await writeFile(join(directory, name), contents);
  }
  const loaded = await loadPublishInput(directory);
  assert.equal(loaded.files.length, 2);
  assert.deepEqual(
    Object.fromEntries(
      loaded.files.map((file) => [file.path, new TextDecoder().decode(file.bytes)]),
    ),
    expected,
  );
});

test(
  "rejects FIFOs without waiting for a writer and rejects device input",
  { timeout: 5000 },
  async () => {
    const directory = await temporaryDirectory();
    const fifo = join(directory, "index.html");
    execFileSync("mkfifo", [fifo]);
    await assert.rejects(loadPublishInput(fifo), /regular file/);
    await assert.rejects(loadPublishInput(directory), /non-regular file/);
    await assert.rejects(loadPublishInput("/dev/null"), /regular file/);
  },
);

test("rejects unsafe logical names and too many files", async () => {
  const directory = await temporaryDirectory();
  const unsafe = join(directory, "bad\\name.html");
  await writeFile(unsafe, "not allowed");
  await assert.rejects(loadPublishInput(directory), /unsafe path/);
  await rm(unsafe);
  for (let index = 0; index <= maxUploadFiles; index += 1) {
    await writeFile(join(directory, `${index}.html`), "");
  }
  await assert.rejects(
    loadPublishInput(directory, "0.html"),
    new RegExp(`exceeds ${maxUploadFiles} files`),
  );
});

// These intercept the filesystem boundary to schedule real mutations precisely;
// all opens, descriptor metadata, directory reads and byte reads still execute.
test("rejects a child replaced with a symlink after descriptor enumeration", async (t) => {
  const directory = await temporaryDirectory();
  const outside = await temporaryDirectory();
  await writeFile(join(directory, "index.html"), "original");
  await writeFile(join(outside, "secret.html"), "outside secret");
  const entries = publishFilesystem.entries;
  let swapped = false;
  t.mock.method(publishFilesystem, "entries", async (handle: InputHandle) => {
    const names = await entries(handle);
    await rm(join(directory, "index.html"));
    await symlink(join(outside, "secret.html"), join(directory, "index.html"));
    swapped = true;
    return names;
  });
  await assert.rejects(loadPublishInput(directory), /ELOOP/);
  assert.equal(swapped, true);
});

test("never traverses a replacement pathname after the held directory is moved", async (t) => {
  const directory = await temporaryDirectory();
  const outside = await temporaryDirectory();
  const root = join(directory, "input");
  await mkdir(root);
  await writeFile(join(root, "index.html"), "original");
  await writeFile(join(outside, "index.html"), "outside secret");
  const entries = publishFilesystem.entries;
  let swapped = false;
  t.mock.method(publishFilesystem, "entries", async (handle: InputHandle) => {
    const names = await entries(handle);
    await rename(root, join(directory, "moved"));
    await symlink(outside, root);
    swapped = true;
    return names;
  });
  await assert.rejects(loadPublishInput(root), /escaped its descriptor root/);
  assert.equal(swapped, true);
});

test("reads held file bytes, not a symlink substituted after open", async (t) => {
  const directory = await temporaryDirectory();
  const outside = await temporaryDirectory();
  const path = join(directory, "index.html");
  await writeFile(path, "original");
  await writeFile(join(outside, "secret.html"), "outside secret");
  const openChild = publishFilesystem.openChild;
  let swapped = false;
  t.mock.method(publishFilesystem, "openChild", async (parent: InputHandle, name: string) => {
    const handle = await openChild(parent, name);
    if (name === "index.html") {
      await rename(path, join(directory, "held.html"));
      await symlink(join(outside, "secret.html"), path);
      swapped = true;
    }
    return handle;
  });
  const loaded = await loadPublishInput(directory);
  assert.equal(swapped, true);
  assert.deepEqual(
    loaded.files.map((file) => new TextDecoder().decode(file.bytes)),
    ["original"],
  );
});

test("rejects size changes on held files and closes every acquired descriptor", async (t) => {
  const directory = await temporaryDirectory();
  const path = join(directory, "index.html");
  await writeFile(path, "original");
  const acquired: { handle: InputHandle; closed: boolean }[] = [];
  const openChild = publishFilesystem.openChild;
  t.mock.method(publishFilesystem, "openChild", async (parent: InputHandle, name: string) => {
    const handle = await openChild(parent, name);
    const record = { handle, closed: false };
    acquired.push(record);
    const close = handle.close.bind(handle);
    t.mock.method(handle, "close", async () => {
      await close();
      record.closed = true;
    });
    if (name === "index.html") {
      const read = handle.read.bind(handle);
      t.mock.method(handle, "read", async (...args: Parameters<InputHandle["read"]>) => {
        await writeFile(path, "changed size");
        return read(...args);
      });
    }
    return handle;
  });
  await assert.rejects(loadPublishInput(directory), /changed while being read/);
  assert.ok(acquired.length > 1);
  assert.ok(acquired.every((record) => record.closed));
});

test("closes retained candidates when later enumeration fails", async (t) => {
  const directory = await temporaryDirectory();
  await writeFile(join(directory, "index.html"), "original");
  const openChild = publishFilesystem.openChild;
  const entries = publishFilesystem.entries;
  let candidate: InputHandle | undefined;
  let closed = false;
  t.mock.method(publishFilesystem, "entries", async (handle: InputHandle) => [
    ...(await entries(handle)),
    "missing.html",
  ]);
  t.mock.method(publishFilesystem, "openChild", async (parent: InputHandle, name: string) => {
    const handle = await openChild(parent, name);
    if (name === "index.html") {
      candidate = handle;
      const close = handle.close.bind(handle);
      t.mock.method(handle, "close", async () => {
        await close();
        closed = true;
      });
    }
    return handle;
  });
  await assert.rejects(loadPublishInput(directory), /ENOENT/);
  assert.ok(candidate);
  assert.equal(closed, true);
});
