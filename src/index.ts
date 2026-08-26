export interface Env {
  ASSETS: R2Bucket;
  DB: D1Database;
}

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

export async function handleRequest(request: Request, _env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({ ok: true, service: "shlook" }, { headers: jsonHeaders });
  }

  return Response.json({ error: "not_found" }, { status: 404, headers: jsonHeaders });
}

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>;
