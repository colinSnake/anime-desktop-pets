import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';

const maxBytes = 6 * 1024 * 1024;
const invalid = () => new Error('invalid_reference_audio');

function pcmWave(bytes: Buffer): boolean {
  if (bytes.length < 44 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) !== bytes.length - 8) return false;
  let format: { rate: number; align: number } | undefined;
  let audio: number | undefined;
  let offset = 12;
  // Limit metadata frames and reject duplicate fmt/data or truncated blocks.
  for (let i = 0; offset < bytes.length && i < 64; i++) {
    if (offset + 8 > bytes.length) return false;
    const kind = bytes.toString('latin1', offset, offset + 4), length = bytes.readUInt32LE(offset + 4);
    const body = offset + 8; offset = body + length + (length % 2);
    if (offset > bytes.length) return false;
    if (kind === 'fmt ') {
      if (format || audio !== undefined || length < 16 || length > 40 || bytes.readUInt16LE(body) !== 1) return false;
      const channels = bytes.readUInt16LE(body + 2), rate = bytes.readUInt32LE(body + 4);
      const align = bytes.readUInt16LE(body + 12), bits = bytes.readUInt16LE(body + 14);
      if (![1, 2].includes(channels) || rate < 8000 || rate > 48000 || ![16, 24].includes(bits) || align !== channels * bits / 8 || bytes.readUInt32LE(body + 8) !== rate * align) return false;
      format = { rate, align };
    } else if (kind === 'data') {
      if (!format || audio !== undefined || length % format.align !== 0) return false;
      audio = length;
    }
  }
  return offset === bytes.length && !!format && audio !== undefined && audio >= format.rate * format.align && audio <= 30 * format.rate * format.align;
}

/** Read from one no-follow descriptor. Only the app-owned copy is used by the model. */
export async function readReferenceAudio(path: string): Promise<Buffer> {
  if (typeof path !== 'string' || path.length > 4096 || path.includes('\0') || !isAbsolute(path) || extname(path).toLowerCase() !== '.wav') throw invalid();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 44 || info.size > maxBytes) throw invalid();
    const bytes = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    const after = await handle.stat();
    const data = bytes.subarray(0, size);
    if (size !== info.size || after.size !== size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || !pcmWave(data)) throw invalid();
    return data;
  } finally { await handle.close(); }
}
