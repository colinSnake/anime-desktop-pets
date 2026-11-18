export async function readBoundedJSON(response: Response, limit: number): Promise<unknown> {
  const body = response.body;
  if (!body) throw Error();
  const contentLength = response.headers.get('content-length');
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') ||
      contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > limit)) {
    void body.cancel().catch(() => {}); throw Error();
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength; if (size > limit) throw Error();
      chunks.push(next.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))) as unknown;
  } catch {
    void reader.cancel().catch(() => {}); throw Error();
  } finally { reader.releaseLock(); }
}
