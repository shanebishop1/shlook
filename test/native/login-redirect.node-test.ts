import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeReturnPath } from "../../src/native/login-redirect.ts";

const asset = "/assets/12345678-1234-1234-1234-123456789abc/";

test("preserves bounded local view paths, nested encoded names and legitimate queries verbatim", () => {
  for (const path of [
    "/",
    "/archive",
    "/archive?",
    "/archive?offset=20&filter=hello%20world",
    asset,
    `${asset}latest`,
    `${asset}nested/hello%20world%23%3F%25.html`,
    `${asset}nested/caf%C3%A9%2520report.html?safeLocation=%2Farchive&source=https%3A%2F%2Fexample.com%2F`,
    `/preview${asset}nested/index.html?view=full`,
    `${asset}index.html?q=${"a".repeat(3900)}`,
  ]) {
    assert.equal(sanitizeReturnPath(path), path);
    // The login query wrapper must survive its one URLSearchParams decoding step.
    const login = new URL(`/login?return=${encodeURIComponent(path)}`, "https://owner.example");
    assert.equal(sanitizeReturnPath(login.searchParams.get("return")), path);
  }
});

test("rejects external, scheme-relative, parser-normalized and non-view return destinations", () => {
  for (const value of [
    undefined,
    null,
    {},
    [],
    1,
    "",
    "https://evil.example/",
    "https:evil.example",
    "javascript:alert(1)",
    "//evil.example/",
    "///evil.example/",
    "/\\evil.example/",
    "\\\\evil.example/",
    "/%2fevil.example/",
    "%2F%2Fevil.example",
    "/%252fevil.example/",
    "/%5cevil.example/",
    "/%255cevil.example/",
    "/login",
    "/login?return=/archive",
    "/api/session",
    "/health",
    "/ui/app.js",
    "/archive/",
    "/latest",
    "/unknown",
    `/assets/not-an-id/index.html`,
    `${asset}../index.html`,
    `${asset}%2e%2e/index.html`,
    `${asset}%252e%252e/index.html`,
    `${asset}.%252e/index.html`,
    `${asset}%2f%2fevil.example`,
    `${asset}%252fetc/passwd`,
    `${asset}index.html#//evil.example`,
    `${asset}index.html?return=ok\r\nLocation:https://evil.example`,
    `${asset}index.html?q=%0d%0a`,
    `${asset}index.html?q=%250A`,
    `${asset}index.html?q=%25250d`,
    `${asset}index.html?q=%00`,
    `${asset}index.html?q=%7f`,
    `${asset}index.html?q=%255c`,
    `${asset}index.html?q=bad%`,
    `${asset}index.html?q=bad%GG`,
    `\t${asset}index.html`,
    `${asset}index\n.html`,
    `${asset}index.html?raw space`,
    `${asset}index.html?q=${"a".repeat(4096)}`,
  ])
    assert.equal(sanitizeReturnPath(value), "/", JSON.stringify(value));
});
