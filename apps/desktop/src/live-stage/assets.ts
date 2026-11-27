import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { liveScenes, type LiveRoleId } from '../../../../packages/contracts/src/live-stage.ts';
import type { StageAsset } from './output.ts';

export type StageMediaPin = { id: string; file: string; bytes: number; sha256: string };
const media: Record<LiveRoleId, readonly StageMediaPin[]> = {
  longmei: [
    { id:'idle', file:'idle.webm', bytes:2741499, sha256:'d8dd3130631c0572caa5b6c4cc6e7b89f373d893d59eb53f1a214a804d2d7a76' },
    { id:'01', file:'01.webm', bytes:2719994, sha256:'90f2f533be1ce164931141abaad07ac2771f3c6886f929d23625da5447bbc17f' },
    { id:'18', file:'18.webm', bytes:4484565, sha256:'6c7b2c861837476eabbcc2be8a0c9fafb759aa42ab0fc29e0d9d10d24e2484bb' },
    { id:'20', file:'20.webm', bytes:3241991, sha256:'91f77d0e245c18396cefbeaae554eae0bff3b2b3870db296cbb88a8df30a4e87' },
  ],
  dafeiyu: [
    { id:'idle', file:'idle.webm', bytes:441437, sha256:'deb965d05a85dacf5ff4a20faa757846f0d11679598c3ec578a5571487660395' },
    { id:'companion-wave', file:'companion-wave.webm', bytes:421669, sha256:'48cd729ccdcf746369942ea954d242e9afdd5643e1dac3827fa5e67450eb8776' },
    { id:'companion-jump', file:'companion-jump.webm', bytes:538110, sha256:'86dcb0c3dd7b651de9c107e927d57a5c4224599101706dbdcc782fa48bcd0ad7' },
    { id:'companion-49c0d89c0992', file:'companion-49c0d89c0992.webm', bytes:352213, sha256:'e3f92df2cf182fdcb109ad0a865689d66e0a0d10db14c1528e5b3cb2f0bf090d' },
  ],
};

export function stageMediaManifest(role: LiveRoleId): readonly StageMediaPin[] {
  return media[role].map(entry => ({...entry}));
}

export function liveStageMediaDirectory(workspaceVideoDirectory: string, role: LiveRoleId): string {
  return role === 'longmei' ? workspaceVideoDirectory : join(workspaceVideoDirectory, 'companion');
}

export function hasRequiredStageActions(role: LiveRoleId, available: readonly string[]): boolean {
  return media[role].filter(entry => entry.id !== 'idle').every(entry => available.includes(entry.id));
}

export function isPinnedStageAsset(bytes: Buffer, pin: Pick<StageMediaPin, 'bytes'|'sha256'>): boolean {
  return bytes.length === pin.bytes && createHash('sha256').update(bytes).digest('hex') === pin.sha256;
}

async function readBounded(path: string, limit: number, pin?: StageMediaPin): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > limit || (pin && (info.size !== pin.bytes || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.nlink !== 1))) throw new Error('stage_asset');
    const bytes = Buffer.allocUnsafe(info.size + 1);
    const region = await file.read(bytes, 0, bytes.length, 0);
    if (region.bytesRead !== info.size) throw new Error('stage_asset');
    const data = bytes.subarray(0, info.size);
    if (pin && !isPinnedStageAsset(data, pin)) throw new Error('stage_asset');
    return data;
  } finally { await file.close(); }
}
export async function loadStageAssets(bundle: string, directory: string, role: LiveRoleId = 'longmei'): Promise<Map<string, StageAsset>> {
  const files = [
    ['index.html','text/html; charset=utf-8'], ['stage.css','text/css; charset=utf-8'], ['stage.js','text/javascript; charset=utf-8'],
    ...liveScenes.flatMap(({id}) => [[`${id}-room.webp`,'image/webp'], [`${id}-desk.webp`,'image/webp']]),
  ] as const;
  const assets = new Map<string, StageAsset>();
  for (const [name,type] of files) assets.set(name, {type,bytes:await readBounded(join(bundle,name), 1024*1024)});
  for (const pin of stageMediaManifest(role)) assets.set(`${pin.id}.webm`, {type:'video/webm',bytes:await readBounded(join(directory,pin.file),pin.bytes,pin)});
  return assets;
}
const artwork = liveScenes.flatMap(({ id }) => [`${id}-cover.webp`, `${id}-preview.webp`]);
export function stageArtworkName(url: string): string | undefined {
  return artwork.find(name => url === `pet-app://workspace/live-stage/${name}`);
}
