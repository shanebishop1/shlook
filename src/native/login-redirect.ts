const RETURN_PATH_LIMIT = 4096;
const VIEW_PATH =
  /^(?:\/|\/archive|\/assets\/[0-9a-f-]{36}\/.*|\/preview\/assets\/[0-9a-f-]{36}\/.+)$/;

/** Only local view routes may be resumed after sign-in; never APIs or login itself. */
export function sanitizeReturnPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > RETURN_PATH_LIMIT ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    // eslint-disable-next-line no-control-regex -- Reject URL/header control-character bypasses.
    /[\u0000-\u001f\u007f\\#]/.test(value) ||
    /%(?![0-9a-f]{2})/i.test(value) ||
    // Check nested escapes too, without decoding/re-encoding legitimate filenames or queries.
    /%(?:25)*(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(value)
  )
    return "/";
  const path = value.split("?", 1)[0]!;
  if (
    !VIEW_PATH.test(path) ||
    /%(?:25)*2f/i.test(path) ||
    path
      .replace(/%(?:25)*2e/gi, ".")
      .split("/")
      .some((part) => part === "." || part === "..")
  )
    return "/";
  try {
    const url = new URL(value, "https://return.invalid");
    // Reject parser normalization, including whitespace, dot segments and authority tricks.
    if (url.origin !== "https://return.invalid" || url.href !== `https://return.invalid${value}`)
      return "/";
    return value;
  } catch {
    return "/";
  }
}
