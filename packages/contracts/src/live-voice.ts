import { liveActionIds, liveVoiceMaxMs, type LiveAction } from './live-stage.ts';

const rate = 24000;
export const liveVoiceClipLimit = 44 + rate * 2 * liveVoiceMaxMs / 1000;
export const liveVoiceWireLimit = (4 + liveVoiceClipLimit) * liveActionIds.length;
export type LiveVoiceBank = Record<LiveAction, Buffer>;
export type LiveVoiceResult = { ok: true; clips: LiveVoiceBank } | { ok: false; error: 'reference-required' | 'voice-busy' | 'voice-failed' };

export function stageVoiceDuration(bytes: Buffer): number | undefined {
  if (bytes.length < 46 || bytes.length > liveVoiceClipLimit || bytes.length % 2 ||
    bytes.toString('ascii',0,4) !== 'RIFF' || bytes.readUInt32LE(4) !== bytes.length - 8 ||
    bytes.toString('ascii',8,16) !== 'WAVEfmt ' || bytes.readUInt32LE(16) !== 16 ||
    bytes.readUInt16LE(20) !== 1 || bytes.readUInt16LE(22) !== 1 || bytes.readUInt32LE(24) !== rate ||
    bytes.readUInt32LE(28) !== rate * 2 || bytes.readUInt16LE(32) !== 2 || bytes.readUInt16LE(34) !== 16 ||
    bytes.toString('ascii',36,40) !== 'data' || bytes.readUInt32LE(40) !== bytes.length - 44) return;
  return Math.ceil((bytes.length - 44) * 1000 / (rate * 2));
}

export function packLiveVoice(clips: LiveVoiceBank): Buffer {
  return Buffer.concat(liveActionIds.flatMap(id => {
    const wav = clips[id];
    if (!stageVoiceDuration(wav)) throw new Error('stage_voice_invalid');
    const size = Buffer.alloc(4); size.writeUInt32LE(wav.length);
    return [size, wav];
  }));
}

export function parseLiveVoice(data: Buffer): LiveVoiceBank | undefined {
  if (data.length > liveVoiceWireLimit) return;
  const clips = {} as LiveVoiceBank;
  let offset = 0;
  for (const id of liveActionIds) {
    if (offset + 4 > data.length) return;
    const size = data.readUInt32LE(offset); offset += 4;
    if (size > liveVoiceClipLimit || offset + size > data.length) return;
    const wav = data.subarray(offset, offset + size); offset += size;
    if (!stageVoiceDuration(wav)) return;
    clips[id] = wav;
  }
  return offset === data.length ? clips : undefined;
}
