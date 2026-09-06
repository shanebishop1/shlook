export async function readJsonWithin(request: Request, maxBytes: number): Promise<unknown> {
  const reader = request.body?.getReader();
  if (reader === undefined) throw new Error("missing body");

  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error("body too large");
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}
