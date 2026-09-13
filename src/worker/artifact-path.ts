export function decodePath(encodedPath: string): string | null {
  try {
    return safePath(decodeURIComponent(encodedPath));
  } catch {
    return null;
  }
}

export function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function safePath(path: string): string | null {
  if (
    path.length === 0 ||
    path.length > 1024 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    Array.from(path).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    return null;
  }
  const segments = path.split("/");
  return segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ? null
    : path;
}
