const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

export function json(data: unknown, status = 200, headers: HeadersInit = jsonHeaders): Response {
  return Response.json(data, { status, headers });
}

export function error(code: string, status: number): Response {
  return json({ error: code }, status);
}
