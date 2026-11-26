import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { liveScenes } from '../../../../packages/contracts/src/live-stage.ts';
import type { StageAsset } from './output.ts';

// These four untouched files come from the existing verified v0.5.1 WebM archive.
const media = {
  'idle.webm': [2741499, 'd8dd3130631c0572caa5b6c4cc6e7b89f373d893d59eb53f1a214a804d2d7a76'],
  '01.webm': [2719994, '90f2f533be1ce164931141abaad07ac2771f3c6886f929d23625da5447bbc17f'],
  '18.webm': [4484565, '6c7b2c861837476eabbcc2be8a0c9fafb759aa42ab0fc29e0d9d10d24e2484bb'],
  '20.webm': [3241991, '91f77d0e245c18396cefbeaae554eae0bff3b2b3870db296cbb88a8df30a4e87'],
} as const;
async function readBounded(path: string, limit: number, pin?: readonly [number, string]): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > limit || (pin && (info.size !== pin[0] || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.nlink !== 1))) throw new Error('stage_asset');
    const bytes = Buffer.allocUnsafe(info.size + 1);
    const region = await file.read(bytes, 0, bytes.length, 0);
    if (region.bytesRead !== info.size) throw new Error('stage_asset');
    const data = bytes.subarray(0, info.size);
    if (pin && createHash('sha256').update(data).digest('hex') !== pin[1]) throw new Error('stage_asset');
    return data;
  } finally { await file.close(); }
}
export async function loadStageAssets(bundle: string, directory: string): Promise<Map<string, StageAsset>> {
  const files = [
    ['index.html','text/html; charset=utf-8'], ['stage.css','text/css; charset=utf-8'], ['stage.js','text/javascript; charset=utf-8'],
    ...liveScenes.flatMap(({id}) => [[`${id}-room.webp`,'image/webp'], [`${id}-desk.webp`,'image/webp']]),
  ] as const;
  const assets = new Map<string, StageAsset>();
  for (const [name,type] of files) assets.set(name, {type,bytes:await readBounded(join(bundle,name), 1024*1024)});
  for (const [name,pin] of Object.entries(media)) assets.set(name, {type:'video/webm',bytes:await readBounded(join(directory,name),pin[0],pin)});
  return assets;
}
const artwork = liveScenes.flatMap(({ id }) => [`${id}-cover.webp`, `${id}-preview.webp`]);
export function stageArtworkName(url: string): string | undefined {
  return artwork.find(name => url === `pet-app://workspace/live-stage/${name}`);
}
