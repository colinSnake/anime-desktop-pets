import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { STARTUP_ORIGIN } from './startup-playback.ts';

const pageHeaders = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; media-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'",
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
};
const textLimit = 32 * 1024;
const videoLimit = 128 * 1024 * 1024;
const assets = new Map([
  [`${STARTUP_ORIGIN}/index.html`, { name: 'index.html', type: 'text/html; charset=utf-8', limit: textLimit }],
  [`${STARTUP_ORIGIN}/player.css`, { name: 'player.css', type: 'text/css; charset=utf-8', limit: textLimit }],
  [`${STARTUP_ORIGIN}/player.js`, { name: 'player.js', type: 'text/javascript; charset=utf-8', limit: textLimit }],
  [`${STARTUP_ORIGIN}/startup.mp4`, { name: 'startup.mp4', type: 'video/mp4', limit: videoLimit }],
]);

function byteRange(range: string, size: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d{0,12})-(\d{0,12})$/.exec(range);
  if (!match || (!match[1] && !match[2])) return;
  const last = size - 1;
  if (!match[1]) {
    const length = Number(match[2]);
    if (!length) return;
    return { start: Math.max(0, size - length), end: last };
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(last, Number(match[2])) : last;
  if (start <= end) return { start, end };
}

export async function startupResponse(directory: string, request: Request): Promise<Response> {
  const asset = request.method === 'GET' ? assets.get(request.url) : undefined;
  const missing = () => new Response(null, { status: 404, headers: pageHeaders });
  if (!asset) return missing();
  let handle: FileHandle | undefined;
  try {
    handle = await open(join(directory, asset.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    const size = info.size;
    if (!info.isFile() || !size || size > asset.limit) return missing();
    const video = asset.type === 'video/mp4';
    const range = video ? request.headers.get('range') : null;
    const part = range === null ? { start: 0, end: size - 1 } : byteRange(range, size);
    if (!part) return new Response(null, { status: 416, headers: {
      ...pageHeaders, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${size}`,
    } });
    const headers: Record<string, string> = {
      ...pageHeaders, 'Content-Type': asset.type, 'Content-Length': String(part.end - part.start + 1),
    };
    if (video) headers['Accept-Ranges'] = 'bytes';
    if (range !== null) headers['Content-Range'] = `bytes ${part.start}-${part.end}/${size}`;
    const stream = handle.createReadStream({ ...part, signal: request.signal });
    handle = undefined; // The stream now owns the descriptor and closes on end, error, or cancellation.
    const body = Readable.toWeb(stream, { strategy: {
      highWaterMark: stream.readableHighWaterMark, size: (chunk: Buffer) => chunk.byteLength,
    } }) as ReadableStream<Uint8Array>;
    return new Response(body, { status: range === null ? 200 : 206, headers });
  } catch { return missing(); }
  finally { await handle?.close().catch(() => {}); }
}
