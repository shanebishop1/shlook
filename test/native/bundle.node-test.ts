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
  assert.match(NATIVE_BUNDLE_CSP, /^sandbox allow-scripts;/);
  assert.doesNotMatch(NATIVE_BUNDLE_CSP, /allow-same-origin|unsafe-eval/);
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

test("rejects srcset, poster, and background resource attributes instead of leaving raw dependencies", () => {
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
