import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { loadPublishInput } from "./cli-files.ts";
import { maxPublicationBytes, maxUploadBytes } from "./upload-limits.ts";

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
