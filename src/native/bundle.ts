import { parse, serialize } from "parse5";
import postcss from "postcss";
import valueParser from "postcss-value-parser";
import { Buffer } from "node:buffer";

/** File paths are publication-relative, and values are their original bytes. */
export type NativeBundleFiles = ReadonlyMap<string, Uint8Array | string>;

export class UnsupportedBundleError extends Error {
  readonly code = "unsupported_bundle";

  constructor(message: string) {
    super(message);
    this.name = "UnsupportedBundleError";
  }
}

export const NATIVE_BUNDLE_CSP =
  "sandbox allow-scripts allow-downloads; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'";

const MAX_FILES = 500;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_COMPILED_DOCUMENT_BYTES = 50 * 1024 * 1024;
const MAX_COMPILED_TOTAL_BYTES = 100 * 1024 * 1024;
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".weba": "audio/webm",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".ogv": "video/ogg",
  ".vtt": "text/vtt",
};
/** Pre-encoded data URLs that inert subresource contexts may keep as-is. */
const INLINE_DATA_URL = /^data:(?:image\/(?!svg)|audio\/|video\/|font\/|text\/vtt[;,])[^,]*,/i;

function fail(message: string): never {
  throw new UnsupportedBundleError(message);
}

function bytes(value: Uint8Array | string): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function safePath(path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\") || hasControlCharacter(path))
    fail("Invalid bundle path");
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return fail("Malformed dependency path");
  }
  if (
    hasControlCharacter(decoded) ||
    decoded !== path ||
    decoded.startsWith("/") ||
    decoded.includes("\\") ||
    decoded.split("/").some((part) => !part || part === ".." || part === ".")
  )
    fail("Dependency path escapes the publication");
  return decoded;
}

function resolvePath(from: string, ref: string): string {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|\/|#)/i.test(ref)) fail("External or absolute static dependency");
  const pathPart = ref.split(/[?#]/, 1)[0]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    return fail("Malformed dependency URL");
  }
  if (!decoded || decoded.includes("\\") || decoded.startsWith("/")) fail("Invalid dependency URL");
  if (hasControlCharacter(decoded)) fail("Control characters in dependency URL");
  const parts = from.split("/").slice(0, -1);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) fail("Dependency escapes the publication");
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

function asText(file: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(file);
  } catch {
    return fail("HTML, JavaScript, and CSS must be UTF-8");
  }
}

const latin1 = (data: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...data.slice(start, end));
const isoMedia = (data: Uint8Array) => latin1(data, 4, 8) === "ftyp";
const matroska = (data: Uint8Array) =>
  data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3;
const ogg = (data: Uint8Array) => latin1(data, 0, 4) === "OggS";
const id3 = (data: Uint8Array) => latin1(data, 0, 3) === "ID3";
const SIGNATURES: Record<string, (data: Uint8Array) => boolean> = {
  ".png": (d) => latin1(d, 0, 8) === "\x89PNG\r\n\x1a\n",
  ".jpg": (d) => d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff,
  ".jpeg": (d) => d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff,
  ".gif": (d) => ["GIF87a", "GIF89a"].includes(latin1(d, 0, 6)),
  ".webp": (d) => latin1(d, 0, 4) === "RIFF" && latin1(d, 8, 12) === "WEBP",
  ".avif": (d) => ["ftypavif", "ftypavis"].includes(latin1(d, 4, 12)),
  ".bmp": (d) => latin1(d, 0, 2) === "BM",
  ".ico": (d) => d[0] === 0 && d[1] === 0 && d[2] === 1 && d[3] === 0,
  ".woff": (d) => latin1(d, 0, 4) === "wOFF",
  ".woff2": (d) => latin1(d, 0, 4) === "wOF2",
  ".ttf": (d) => d[0] === 0 && d[1] === 1 && d[2] === 0 && d[3] === 0,
  ".otf": (d) => latin1(d, 0, 4) === "OTTO",
  ".mp3": (d) => id3(d) || (d[0] === 0xff && (d[1]! & 0xe0) === 0xe0),
  ".wav": (d) => latin1(d, 0, 4) === "RIFF" && latin1(d, 8, 12) === "WAVE",
  ".ogg": ogg,
  ".oga": ogg,
  ".opus": ogg,
  ".ogv": ogg,
  ".flac": (d) => id3(d) || latin1(d, 0, 4) === "fLaC",
  ".m4a": isoMedia,
  ".mp4": isoMedia,
  ".m4v": isoMedia,
  ".mov": (d) => ["ftyp", "moov", "mdat", "free", "wide", "skip"].includes(latin1(d, 4, 8)),
  ".aac": (d) => id3(d) || (d[0] === 0xff && (d[1]! & 0xf6) === 0xf0),
  ".weba": matroska,
  ".webm": matroska,
  ".mkv": matroska,
  ".vtt": (d) => /^(?:\ufeff)?WEBVTT(?:[ \t\r\n]|$)/.test(new TextDecoder().decode(d.slice(0, 16))),
};

function checkAsset(path: string, data: Uint8Array): string {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) return fail("Unsupported static asset type");
  if (!SIGNATURES[ext]!(data)) fail(`Asset content does not match its ${ext} extension`);
  return mime;
}

type CompileBudget = { documentBytes: number; totalBytes: number };

function reserve(budget: CompileBudget, amount: number): void {
  if (
    !Number.isSafeInteger(amount) ||
    budget.documentBytes + amount > MAX_COMPILED_DOCUMENT_BYTES ||
    budget.totalBytes + amount > MAX_COMPILED_TOTAL_BYTES
  )
    fail("Compiled bundle exceeds the generated output limit");
  budget.documentBytes += amount;
  budget.totalBytes += amount;
}

function dataUrl(
  path: string,
  files: Map<string, Uint8Array>,
  ref: string,
  budget: CompileBudget,
): string {
  // Already-inline bytes were counted with their containing document.
  if (/^\s*data:/i.test(ref)) {
    const inline = ref.trim();
    if (!INLINE_DATA_URL.test(inline)) fail("Unsupported inline data URL type");
    return inline;
  }
  const resolved = resolvePath(path, ref);
  const data = files.get(resolved);
  if (!data) return fail(`Unresolved static dependency: ${resolved}`);
  const mime = checkAsset(resolved, data);
  const encodedLength = Math.ceil(data.byteLength / 3) * 4;
  reserve(budget, encodedLength + mime.length + 13);
  return `data:${mime};base64,${Buffer.from(data).toString("base64")}`;
}

function attrs(node: any): Map<string, string> {
  return new Map((node.attrs ?? []).map((a: any) => [a.name.toLowerCase(), a.value]));
}

function setAttr(node: any, name: string, value: string): void {
  node.attrs ??= [];
  const attr = node.attrs.find((item: any) => item.name.toLowerCase() === name);
  if (attr) attr.value = value;
  else node.attrs.push({ name, value });
}

function removeAttr(node: any, name: string): void {
  if (node.attrs) node.attrs = node.attrs.filter((a: any) => a.name.toLowerCase() !== name);
}

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Conservative upper bound for parse5's HTML serialization of a parsed tree. */
function estimateSerializedBytes(node: any): number {
  let size = 0;
  const add = (amount: number): void => {
    size += amount;
    if (!Number.isSafeInteger(size) || size > MAX_COMPILED_DOCUMENT_BYTES)
      fail("Compiled document exceeds the generated output limit");
  };
  const visit = (current: any): void => {
    if (current.nodeName === "#text") {
      // Text and raw-text serialization preserve bytes except HTML-sensitive
      // ASCII characters, each of which expands to at most a 6-byte entity.
      add(Buffer.byteLength(current.value ?? "", "utf8") * 6);
      return;
    }
    if (current.nodeName === "#comment") {
      add(Buffer.byteLength(current.data ?? "", "utf8") + 7);
      return;
    }
    if (current.nodeName === "#documentType") {
      add(
        32 +
          Buffer.byteLength(current.name ?? "html", "utf8") +
          Buffer.byteLength(current.publicId ?? "", "utf8") * 6 +
          Buffer.byteLength(current.systemId ?? "", "utf8") * 6,
      );
      return;
    }
    const tag = current.tagName?.toLowerCase();
    if (tag) {
      add(tag.length * 2 + 5); // opening and, unless void, closing tag syntax
      for (const attr of current.attrs ?? []) {
        add(attr.name.length + 4 + Buffer.byteLength(attr.value ?? "", "utf8") * 6);
      }
    }
    if (current.content) visit(current.content);
    for (const child of current.childNodes ?? []) visit(child);
    if (tag && !VOID_ELEMENTS.has(tag)) add(tag.length + 3);
  };
  visit(node);
  return size;
}

function cssInline(
  path: string,
  css: string,
  files: Map<string, Uint8Array>,
  budget: CompileBudget,
): string {
  if (/<\/style/i.test(css)) fail("CSS contains a raw-text closing sequence");
  // CSS escapes can disguise @import and URL schemes across parser versions.
  // This static subset deliberately does not accept them.
  if (css.includes("\\")) fail("Escaped CSS syntax is unsupported");
  let root: ReturnType<typeof postcss.parse>;
  try {
    root = postcss.parse(css);
  } catch {
    return fail("Invalid CSS syntax");
  }
  root.walkAtRules((rule) => {
    if (rule.name.toLowerCase() === "import" || /\\/.test(rule.name))
      fail("CSS @import and escaped at-rules are unsupported");
  });
  root.walkDecls((decl) => {
    const parsed = valueParser(decl.value);
    parsed.walk((node) => {
      if (
        node.type === "function" &&
        ["image-set", "-webkit-image-set", "image"].includes(node.value.toLowerCase())
      )
        fail("CSS image-set and string-source image functions are unsupported");
      if (node.type !== "function" || node.value.toLowerCase() !== "url") return;
      if (valueParser.stringify(node.nodes).includes("\\"))
        fail("Escaped CSS URLs are unsupported");
      const ref = valueParser
        .stringify(node.nodes)
        .trim()
        .replace(/^(['"])(.*)\1$/, "$2");
      const url = dataUrl(path, files, ref, budget);
      node.nodes = [{ type: "word", value: `"${url}"` } as any];
    });
    decl.value = parsed.toString();
  });
  return root.toString();
}

function compileHtml(
  path: string,
  input: string,
  files: Map<string, Uint8Array>,
  budget: CompileBudget,
): string {
  reserve(budget, Buffer.byteLength(input, "utf8"));
  let doc: any;
  try {
    doc = parse(input);
  } catch {
    return fail(`Invalid HTML document: ${path}`);
  }
  const visit = (node: any): void => {
    const tag = node.tagName?.toLowerCase();
    const a = attrs(node);
    if (tag === "base") fail("HTML base elements are unsupported");
    if (tag === "svg") fail("Inline SVG is unsupported");
    if ([...a.keys()].some((name) => name.startsWith("on")) || a.has("srcdoc"))
      fail("Inline handlers and nested documents are unsupported");
    if (a.has("srcset")) fail("srcset is unsupported; use one local img src");
    if (a.has("background")) fail("background resource attributes are unsupported");
    if (a.has("poster")) {
      if (tag !== "video") fail("poster is only supported on video elements");
      const poster = dataUrl(path, files, a.get("poster")!, budget);
      if (!/^data:image\//i.test(poster)) fail("Video posters must be images");
      setAttr(node, "poster", poster);
    }
    for (const [name, value] of a) {
      if (
        ["href", "xlink:href", "action", "formaction"].includes(name) &&
        /^\s*javascript:/i.test(value)
      )
        fail("Executable URLs are unsupported");
    }
    if (["iframe", "frame", "object", "embed", "portal"].includes(tag))
      fail("Nested browsing contexts and embedded objects are unsupported");
    if (tag === "script") {
      if (a.get("type")?.trim().toLowerCase() === "module") fail("Module scripts are unsupported");
      if (a.has("src")) {
        if (a.has("defer")) fail("Deferred classic scripts are unsupported");
        const src = a.get("src")!;
        const scriptPath = resolvePath(path, src);
        if (!/\.js$/i.test(scriptPath)) fail("Classic scripts must use the .js extension");
        const script = files.get(scriptPath);
        if (!script) fail(`Unresolved script: ${scriptPath}`);
        const source = asText(script);
        if (/<\/script/i.test(source)) fail("Script contains a raw-text closing sequence");
        reserve(budget, Buffer.byteLength(source, "utf8"));
        node.childNodes = [{ nodeName: "#text", value: source, parentNode: node }];
        removeAttr(node, "src");
        removeAttr(node, "type");
      } else if (
        a.get("type") &&
        !["text/javascript", "application/javascript"].includes(a.get("type")!.toLowerCase())
      )
        fail("Non-classic script type is unsupported");
    }
    if (tag === "link" && /(?:^|\s)stylesheet(?:\s|$)/i.test(a.get("rel") ?? "")) {
      const relTokens = (a.get("rel") ?? "").toLowerCase().split(/\s+/);
      if (relTokens.includes("alternate") || a.has("disabled") || a.has("title"))
        fail("Alternate or disabled stylesheets are unsupported");
      const href = a.get("href");
      if (!href) fail("Stylesheet link has no href");
      const cssPath = resolvePath(path, href);
      if (!/\.css$/i.test(cssPath)) fail("Stylesheets must use the .css extension");
      const css = files.get(cssPath);
      if (!css) fail(`Unresolved stylesheet: ${cssPath}`);
      reserve(budget, css.byteLength);
      const style = {
        nodeName: "style",
        tagName: "style",
        attrs: node.attrs
          .filter((attr: any) => attr.name.toLowerCase() === "media")
          .map((attr: any) => ({ ...attr })),
        namespaceURI: "http://www.w3.org/1999/xhtml",
        childNodes: [{ nodeName: "#text", value: cssInline(cssPath, asText(css), files, budget) }],
      };
      node.tagName = "style";
      node.nodeName = "style";
      node.attrs = style.attrs;
      node.childNodes = style.childNodes;
    }
    if (tag === "style") {
      for (const child of node.childNodes ?? [])
        if (child.nodeName === "#text") child.value = cssInline(path, child.value, files, budget);
    }
    if (tag === "img") {
      if (a.has("src")) setAttr(node, "src", dataUrl(path, files, a.get("src")!, budget));
    }
    if (a.has("style")) setAttr(node, "style", cssInline(path, a.get("style")!, files, budget));
    // These attributes load bytes during document rendering. Other URL-bearing
    // attributes (such as an anchor href) are navigations, not subresources.
    if (["audio", "video", "source", "track", "input"].includes(tag) && a.has("src")) {
      setAttr(node, "src", dataUrl(path, files, a.get("src")!, budget));
    }
    if (tag === "link" && a.has("href") && !/(?:^|\s)stylesheet(?:\s|$)/i.test(a.get("rel") ?? ""))
      fail("Non-stylesheet linked resources are unsupported");
    if (node.content) visit(node.content);
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(doc);
  const estimatedBytes = estimateSerializedBytes(doc);
  if (estimatedBytes > budget.documentBytes) reserve(budget, estimatedBytes - budget.documentBytes);
  const html = serialize(doc);
  if (Buffer.byteLength(html, "utf8") > MAX_COMPILED_DOCUMENT_BYTES)
    fail("Compiled document exceeds the generated output limit");
  return html;
}

/** Compiles each HTML member, preserving its publication-relative map key. */
export function compileNativeBundle(
  input: NativeBundleFiles,
  entrypoint?: string,
): Map<string, string> {
  if (input.size > MAX_FILES) fail("Bundle contains too many files");
  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (const [rawPath, value] of input) {
    const path = safePath(rawPath);
    if (files.has(path)) fail("Duplicate canonical bundle path");
    const data = bytes(value);
    if (data.byteLength > MAX_FILE_BYTES) fail("Bundle file exceeds the file size limit");
    total += data.byteLength;
    if (total > MAX_TOTAL_BYTES) fail("Bundle exceeds the total size limit");
    files.set(path, data);
  }
  const output = new Map<string, string>();
  const budget: CompileBudget = { documentBytes: 0, totalBytes: 0 };
  if (entrypoint) {
    const normalizedEntrypoint = safePath(entrypoint);
    if (/\.mdx?$/i.test(normalizedEntrypoint) || /\.svg$/i.test(normalizedEntrypoint))
      fail("MDX and SVG entrypoints are unsupported");
    if (!files.has(normalizedEntrypoint)) fail("Entrypoint is missing from the bundle");
  }
  for (const [path, data] of files) {
    if (/\.html?$/i.test(path)) {
      budget.documentBytes = 0;
      output.set(path, compileHtml(path, asText(data), files, budget));
    }
  }
  return output;
}
