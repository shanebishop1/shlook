export function ownerFavicon(): Response {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="shlook"><rect width="128" height="128" rx="22" fill="#0c0f0d"/><path d="M22 29 106 11v31L52 54l54 14v31l-84 19V87l54-13-54-14z" fill="#4c9874"/><path d="m52 54 54-12-30 32-54-14z" fill="#d6a36f"/></svg>`;
  return new Response(svg, {
    headers: {
      "cache-control": "public, max-age=86400",
      "content-security-policy": "default-src 'none'; sandbox",
      "content-type": "image/svg+xml; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}
