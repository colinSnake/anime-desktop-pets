import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { mediaFiles } from './playback';

import { companionHost, previewScheme } from './video-role';
export { previewURL, previewScheme } from './video-role';
export const captionFont = 'caption-font.ttf';
const captionFontBytes = 4_083_908;
const approvedCaptionHash = '5f5099a065b5eb3ba55e9bd293af7707fdbd7858bf99d9381b7c6319445c2e62';

/** Return the exact validated bytes once; requests never reopen a user-supplied file. */
export async function readCaptionFont(privateMediaDirectory: string): Promise<ArrayBuffer | undefined> {
  try {
    const file = await open(join(privateMediaDirectory, captionFont), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile() || (info.mode & 0o077) || info.size !== captionFontBytes) return;
      const data = Buffer.alloc(captionFontBytes + 1);
      const { bytesRead } = await file.read(data, 0, data.byteLength, 0);
      const bytes = data.subarray(0, bytesRead);
      if (bytesRead === captionFontBytes && createHash('sha256').update(bytes).digest('hex') === approvedCaptionHash) {
        return data.buffer.slice(0, bytesRead);
      }
    } finally { await file.close(); }
  } catch { /* Optional local asset; the caption falls back to a system font. */ }
}

const routes = new Map<string, string>([
  ['index.html', 'text/html; charset=utf-8'], ['renderer.js', 'text/javascript; charset=utf-8'],
  ['style.css', 'text/css; charset=utf-8'], [captionFont, 'font/ttf'], ...mediaFiles.map(clip => [`${clip}.webm`, 'video/webm'] as const),
]);
export const maxMediaBytes = 32 * 1024 * 1024;
const policy = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function byteRange(raw: string, size: number): [number, number] | undefined {
  const match = /^bytes=(\d{0,10})-(\d{0,10})$/.exec(raw);
  if (!match || (!match[1] && !match[2])) return;
  const suffix = !match[1];
  const start = suffix ? Math.max(0, size - Number(match[2])) : Number(match[1]);
  const end = !suffix && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (start < size && start <= end) return [start, end];
}

export async function previewResponse(folder: string, request: Request, mediaFolder = folder, font?: ArrayBuffer, host: 'preview' | typeof companionHost = 'preview'): Promise<Response> {
  const url = new URL(request.url);
  const name = url.pathname.slice(1);
  const type = routes.get(name);
  if (url.protocol !== `${previewScheme}:` || url.host !== host || url.username || url.password || url.search || url.hash || !type ||
      (host === companionHost && type === 'video/webm' && name !== 'idle.webm')) {
    return new Response(null, { status: 404 });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
  if (name === captionFont) {
    if (!font) return new Response(null, { status: 404 });
    return new Response(request.method === 'HEAD' ? null : font, { headers: {
      'content-type': type, 'content-length': String(font.byteLength), 'content-security-policy': policy,
      'x-content-type-options': 'nosniff', 'cache-control': 'no-store',
    } });
  }
  const file = join(type === 'video/webm' ? mediaFolder : folder, name);
  const info = await lstat(file).catch(() => undefined);
  if (!info?.isFile() || info.size < 1 || info.size > maxMediaBytes) return new Response(null, { status: 404 });
  const size = info.size;
  const range = type === 'video/webm' ? request.headers.get('range') : null;
  const slice = range === null ? undefined : byteRange(range, size);
  if (range !== null && !slice) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
  const headers = new Headers({ 'content-type': type, 'content-security-policy': policy,
    'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
  if (type === 'video/webm') headers.set('accept-ranges', 'bytes');
  const [start, end] = slice ?? [0, size - 1];
  headers.set('content-length', String(end - start + 1));
  if (slice) headers.set('content-range', `bytes ${start}-${end}/${size}`);
  const body = request.method === 'HEAD' ? null
    : Readable.toWeb(createReadStream(file, { start, end })) as unknown as BodyInit;
  return new Response(body, { status: slice ? 206 : 200, headers });
}
