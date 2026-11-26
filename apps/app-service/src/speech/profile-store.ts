import { randomBytes } from 'node:crypto';
import { rename, type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { isSpeechEnableInput, isSpeechTranscriptInput } from '../../../../packages/contracts/src/speech.ts';
import { PrivateDirectory, sameFile } from '../models/private-directory.ts';
import { isReferenceAudio, referenceAudioLimit } from './reference-audio.ts';

const file = 'reference-profile.json';
const limit = Math.ceil(referenceAudioLimit / 3) * 4 + 32 * 1024;
export type SpeechProfile = { audio: Buffer; transcript?: string; enabled: boolean };
const invalid = () => new Error('invalid_speech_profile');

/** Called only by the service holding the business workspace's writer lease. */
export class SpeechProfileStore {
  private readonly directory: PrivateDirectory;
  constructor(root: string) { this.directory = new PrivateDirectory(root); }

  async read(): Promise<SpeechProfile | undefined> {
    const record = await this.directory.read(file, limit);
    if (!record) return;
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(record.bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![1, 2].includes(value.schemaVersion) ||
        Object.keys(value).some(key => !['schemaVersion', 'wav', 'transcript', ...(value.schemaVersion === 2 ? ['enabled'] : [])].includes(key)) ||
        typeof value.wav !== 'string' || (Object.hasOwn(value, 'transcript') && !isSpeechTranscriptInput({ referenceTranscript: value.transcript })) ||
        (value.schemaVersion === 2 && typeof value.enabled !== 'boolean')) throw invalid();
    const audio = Buffer.from(value.wav, 'base64');
    if (!isReferenceAudio(audio) || audio.toString('base64') !== value.wav || (value.enabled === true && !isSpeechEnableInput({ referenceTranscript: value.transcript }))) throw invalid();
    return { audio, transcript: value.transcript, enabled: value.schemaVersion === 2 && value.enabled === true };
  }

  async write(profile?: SpeechProfile): Promise<void> {
    const current = await this.directory.file(file);
    if (!profile) {
      if (current) {
        await this.directory.removeOwned(file, current);
        await this.directory.sync();
      }
      return;
    }
    if (!isReferenceAudio(profile.audio) || (profile.transcript !== undefined && !isSpeechTranscriptInput({ referenceTranscript: profile.transcript })) ||
        typeof profile.enabled !== 'boolean' || (profile.enabled && !isSpeechEnableInput({ referenceTranscript: profile.transcript }))) throw invalid();
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 2, wav: profile.audio.toString('base64'), transcript: profile.transcript, enabled: profile.enabled }));
    if (bytes.length > limit) throw invalid();
    const temporary = `.reference-${randomBytes(12).toString('hex')}.tmp`;
    let handle: FileHandle | undefined, identity: Stats | undefined;
    try {
      handle = await this.directory.create(temporary);
      identity = await handle.stat();
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close(); handle = undefined;
      const latest = await this.directory.file(file);
      if (current ? !latest || !sameFile(current, latest) || current.ctimeMs !== latest.ctimeMs : latest) throw invalid();
      await rename(this.directory.path(temporary), this.directory.path(file));
      await this.directory.sync();
    } finally {
      await handle?.close().catch(() => {});
      if (identity) await this.directory.removeOwned(temporary, identity).catch(() => {});
    }
  }
}
