import { coverURL, dafeiyu, longmei } from '../../../packages/contracts/src/built-in-pets.ts';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export const COVER_URL = coverURL(longmei);
export const COMPANION_COVER_URL = coverURL(dafeiyu);
const maximum = 1024 * 1024;
const maximumEdge = 556; // Longest edge of the approved 2× cover artwork.
const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function readCover(path: string): Promise<Buffer | undefined> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 33 || info.size > maximum) return;
    const data = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    if (bytesRead !== data.length || !data.subarray(0, 8).equals(pngHeader) ||
      data.readUInt32BE(8) !== 13 || data.toString('ascii', 12, 16) !== 'IHDR' ||
      ![data.readUInt32BE(16), data.readUInt32BE(20)].every(n => n > 0 && n <= maximumEdge)) return;
    return data;
  } finally { await handle.close(); }
}

/** Fixed local still images; no prepared animation, Python or Pillow. Missing still uses the UI placeholder. */
export class PetCoverProvider {
  private readonly covers = new Map<string, {path: string; pending?: Promise<Buffer | undefined> }>();
  constructor(path: string, companionPath?: string) {
    this.covers.set(COVER_URL, { path });
    if (companionPath) this.covers.set(COMPANION_COVER_URL, { path: companionPath });
  }

  async response(url: string, method: string): Promise<Response | undefined> {
    const cover = method === 'GET' ? this.covers.get(url) : undefined;
    if (!cover) return;
    const data = await (cover.pending ??= readCover(cover.path).catch(() => undefined));
    if (!data) return new Response('', { status: 404 });
    return new Response(new Uint8Array(data), { headers: {
      'content-type': 'image/png', 'x-content-type-options': 'nosniff',
      'cache-control': 'no-store', 'content-security-policy': "default-src 'none'",
    } });
  }
}
