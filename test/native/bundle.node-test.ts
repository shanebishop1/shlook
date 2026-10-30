import assert from "node:assert/strict";
import test from "node:test";
import postcss from "postcss";
import {
  compileNativeBundle,
  NATIVE_BUNDLE_CSP,
  UnsupportedBundleError,
} from "../../src/native/bundle.ts";

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const compile = (files: Record<string, Uint8Array | string>, entry = "index.html") =>
  compileNativeBundle(new Map(Object.entries(files)), entry);
const unsupported = (fn: () => unknown) =>
  assert.throws(
    fn,
    (error: unknown) =>
      error instanceof UnsupportedBundleError && error.code === "unsupported_bundle",
  );

test("inlines classic script, stylesheet and verified raster assets in every HTML document", () => {
  const result = compile({
    "index.html":
      '<!doctype html><link rel="stylesheet" href="css/site.css"><script src="js/app.js"></script><img src="img/pixel.png">',
    "nested/page.html": '<script src="../js/app.js"></script>',
    "css/site.css": "body { background: url(../img/pixel.png) }",
    "js/app.js": "window.ready = true",
    "img/pixel.png": png,
  });
  assert.equal(result.size, 2);
  assert.match(result.get("index.html")!, /window\.ready = true/);
  assert.match(result.get("index.html")!, /data:image\/png;base64,/);
  assert.match(result.get("nested/page.html")!, /window\.ready = true/);
  assert.match(NATIVE_BUNDLE_CSP, /worker-src 'none'/);
  assert.match(NATIVE_BUNDLE_CSP, /^sandbox allow-scripts allow-downloads;/);
  assert.doesNotMatch(
    NATIVE_BUNDLE_CSP,
    /allow-same-origin|allow-popups|allow-top-navigation|unsafe-eval/,
  );
  const compiledStyle = result.get("index.html")!.match(/<style>(.*?)<\/style>/)?.[1];
  assert.ok(compiledStyle);
  const parsedStyle = postcss.parse(compiledStyle);
  assert.match(parsedStyle.toString(), /background: url\("data:image\/png;base64,[^"]+"\)/);
});

test("rejects raw-text escapes, modules, nested contexts, base tags and unresolved/external resources", () => {
  unsupported(() =>
    compile({ "index.html": '<script src="x.js"></script>', "x.js": 'const x = "</script>"' }),
  );
  for (const markup of [
    '<script type="module">x</script>',
    '<iframe src="x.html"></iframe>',
    '<object data="x"></object>',
    '<base href="/">',
  ]) {
    unsupported(() => compile({ "index.html": markup }));
  }
  unsupported(() => compile({ "index.html": '<img src="https://evil.test/x.png">' }));
  unsupported(() => compile({ "index.html": '<script src="missing.js"></script>' }));
});

test("walks template contents and compiles embedded dependencies inside templates", () => {
  const result = compile({
    "index.html": '<template><img src="pixel.png"><script src="classic.js"></script></template>',
    "pixel.png": png,
    "classic.js": "window.templateScript = true",
  });
  assert.match(result.get("index.html")!, /data:image\/png;base64,/);
  assert.match(result.get("index.html")!, /window\.templateScript = true/);
  unsupported(() =>
    compile({ "index.html": '<template><script type="module">x</script></template>' }),
  );
});

test("rejects deferred external classic scripts in every compiled HTML member", () => {
  for (const html of [
    '<script defer src="app.js"></script>',
    '<script defer="false" src="app.js"></script>',
  ]) {
    unsupported(() => compile({ "index.html": html, "app.js": "window.ready = true" }));
  }
  unsupported(() =>
    compile({
      "index.html": '<template><script defer src="app.js"></script></template>',
      "app.js": "window.ready = true",
    }),
  );
  unsupported(() =>
    compile({
      "nested/page.html": '<script defer src="../app.js"></script>',
      "index.html": "<p>entry</p>",
      "app.js": "window.ready = true",
    }),
  );
  const normal = compile({
    "index.html": '<script src="app.js"></script>',
    "app.js": "window.ready = true",
  }).get("index.html")!;
  assert.match(normal, /<script>window\.ready = true<\/script>/);
});

test("CSS parser catches escaped imports and path traversal; rejects MIME confusion and srcset escapes", () => {
  unsupported(() =>
    compile({
      "index.html": '<link rel="stylesheet" href="x.css">',
      "x.css": '@im\\port "https://evil.test/x.css";',
    }),
  );
  unsupported(() =>
    compile({
      "index.html": '<link rel="stylesheet" href="x.css">',
      "x.css": "a { background: url(\\2e \\2e /secret.png) }",
    }),
  );
  unsupported(() =>
    compile({ "index.html": '<img src="x.png">', "x.png": '<svg onload="alert(1)">' }),
  );
  unsupported(() => compile({ "index.html": '<img srcset="../../outside.png 2x">' }));
  unsupported(() => compile({ "index.html": '<img srcset="one.png 1x, two.png 2x">' }));
});

test("rejects string-source CSS image functions in inline, style-element, and linked CSS", () => {
  for (const [html, files] of [
    ["<div style='background:image-set(\"https://evil.test/x.png\" 1x)'></div>", {}],
    ['<style>.x{background:-webkit-image-set("local.png" 1x)}</style>', {}],
    ['<style>.x{background:image("local.png")}</style>', {}],
    [
      '<link rel="stylesheet" href="x.css">',
      { "x.css": '.x{background:image-set("local.png" 1x)}' },
    ],
  ] as const) {
    unsupported(() => compile({ "index.html": html, ...files }));
  }
  const safe = compile({
    "index.html": '<div style="width:calc(100% - 2px);color:rgb(1 2 3)"></div>',
  }).get("index.html")!;
  assert.match(safe, /calc\(100% - 2px\)/);
  assert.match(safe, /rgb\(1 2 3\)/);
});

test("preserves stylesheet media and rejects conditional stylesheet links", () => {
  const compiled = compile({
    "index.html": '<link rel="stylesheet" href="x.css" media="print and (min-width: 20px)">',
    "x.css": "body { color: red }",
  }).get("index.html")!;
  assert.match(compiled, /<style media="print and \(min-width: 20px\)">/);
  for (const link of [
    '<link rel="alternate stylesheet" href="x.css">',
    '<link rel="stylesheet" href="x.css" disabled>',
    '<link rel="stylesheet" href="x.css" title="alternate theme">',
  ]) {
    unsupported(() => compile({ "index.html": link, "x.css": "body { color: red }" }));
  }
});

test("rejects srcset, external or missing posters, and background attributes instead of leaving raw dependencies", () => {
  for (const markup of [
    '<source srcset="https://example.test/a.png 1x">',
    '<source srcset="local.png 1x">',
    '<video poster="https://example.test/poster.png"></video>',
    '<video poster="local.png"></video>',
    '<body background="https://example.test/bg.png"></body>',
    '<body background="local.png"></body>',
  ]) {
    unsupported(() => compile({ "index.html": markup }));
  }
});

test("rejects unsafe names and executable entrypoints", () => {
  unsupported(() => compile({ "../index.html": "x" }, "../index.html"));
  unsupported(() => compile({ "index.mdx": "# not safe" }, "index.mdx"));
  unsupported(() => compile({ "index.svg": "<svg/>" }, "index.svg"));
  for (const path of [
    "a//b.html",
    "a/./b.html",
    "a/%2e%2e/b.html",
    "a/%00b.html",
    "a/\u007fb.html",
  ]) {
    unsupported(() => compile({ [path]: "<p>bad</p>" }, path));
  }
});

test("enforces deterministic file-count and per-file byte limits", () => {
  const tooMany = new Map<string, string>([["index.html", "<p>ok</p>"]]);
  for (let i = 0; i < 500; i++) tooMany.set(`f${i}.txt`, "x");
  unsupported(() => compileNativeBundle(tooMany));
  unsupported(() =>
    compileNativeBundle(new Map([["index.html", new Uint8Array(25 * 1024 * 1024 + 1)]])),
  );
  const repeatedAsset = new Uint8Array(12 * 1024 * 1024);
  repeatedAsset.set(png);
  unsupported(() =>
    compileNativeBundle(
      new Map<string, Uint8Array | string>([
        [
          "index.html",
          '<img src="large.png"><img src="large.png"><img src="large.png"><img src="large.png">',
        ],
        ["large.png", repeatedAsset],
      ]),
    ),
  );
});

test("estimates entity expansion before serializing text and attributes", () => {
  const amplified = "&".repeat(9 * 1024 * 1024);
  unsupported(() => compile({ "index.html": `<p>${amplified}</p>` }));
  unsupported(() => compile({ "index.html": `<div title="${amplified}"></div>` }));
});

const mp3 = Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]);
const mp4 = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const webm = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);
const wav = new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt ");

test("inlines verified audio, video, captions and posters and allows only data media", () => {
  const html = compile({
    "index.html":
      '<audio controls src="song.mp3"></audio><audio><source src="a/b.wav"></audio>' +
      '<video poster="p.png"><source src="clip.mp4"><source src="clip.webm"><track src="c.vtt"></video>',
    "song.mp3": mp3,
    "a/b.wav": wav,
    "clip.mp4": mp4,
    "clip.webm": webm,
    "c.vtt": "WEBVTT\n\n00:00.000 --> 00:01.000\nHi",
    "p.png": png,
  }).get("index.html")!;
  for (const mime of ["audio/mpeg", "audio/wav", "video/mp4", "video/webm", "text/vtt"])
    assert.ok(html.includes(`src="data:${mime};base64,`), mime);
  assert.match(html, /poster="data:image\/png;base64,/);
  assert.match(NATIVE_BUNDLE_CSP, /media-src data: blob:;/);
  assert.doesNotMatch(NATIVE_BUNDLE_CSP, /media-src[^;]*(?:'self'|https?:|\*)/);
});

test("rejects mismatched media bytes, non-image posters and unsafe inline data URLs", () => {
  unsupported(() => compile({ "index.html": '<audio src="x.mp3"></audio>', "x.mp3": png }));
  unsupported(() => compile({ "index.html": '<video src="x.mp4"></video>', "x.mp4": mp3 }));
  unsupported(() => compile({ "index.html": '<track src="x.vtt">', "x.vtt": "not captions" }));
  unsupported(() => compile({ "index.html": '<video poster="x.mp3"></video>', "x.mp3": mp3 }));
  unsupported(() => compile({ "index.html": '<img poster="x.png">', "x.png": png }));
  for (const url of ["data:image/svg+xml;base64,PHN2Zz4=", "data:text/html,<b>x</b>"])
    unsupported(() => compile({ "index.html": `<img src="${url}">` }));
});

test("keeps pre-encoded media and image data URLs as-is", () => {
  const html = compile({
    "index.html":
      '<audio src="data:audio/mpeg;base64,SUQz"></audio><img src=" data:image/png;base64,iVBO">' +
      "<style>.x{background:url(data:image/png;base64,iVBO)}</style>",
  }).get("index.html")!;
  assert.match(html, /<audio src="data:audio\/mpeg;base64,SUQz">/);
  assert.match(html, /<img src="data:image\/png;base64,iVBO">/);
  assert.match(html, /url\("data:image\/png;base64,iVBO"\)/);
});
