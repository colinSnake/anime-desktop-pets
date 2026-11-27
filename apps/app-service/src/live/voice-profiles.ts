import { createHash, randomBytes } from 'node:crypto';
import { lstat, rename, type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { isAbsolute, join, parse, sep } from 'node:path';
import { liveRoleForPackage } from '../../../../packages/contracts/src/character-personas.ts';
import { isLiveVoiceProfileTarget, isLiveVoiceProfileMutation, isLiveVoiceTranscriptInput, type LiveVoiceProfileTarget, type LiveVoiceProfileMutation, type LiveVoiceTranscriptInput, type LiveVoiceProfileSnapshot, type LiveVoiceProfileResult, type LiveVoiceProfileError } from '../../../../packages/contracts/src/live-voice-profile.ts';
import { type LiveVoiceResult } from '../../../../packages/contracts/src/live-voice.ts';
import { type PackageReference } from '../../../../packages/contracts/src/pets.ts';
import { isSpeechTranscriptInput } from '../../../../packages/contracts/src/speech.ts';
import { PrivateDirectory, sameFile } from '../models/private-directory.ts';
import type { PetWorkspace } from '../pet-workspace.ts';
import type { BubbleSpeech, SpeechProfileInput } from '../speech/bubble-speech.ts';
import { isReferenceAudio, readReferenceAudio, referenceAudioLimit } from '../speech/reference-audio.ts';
import type { LiveRoleBindingStore } from './role-bindings.ts';
import type { LiveShareStore } from './sharing.ts';

const profileFile = 'profile.json', lockFile = '.voice.lock', metadataLimit = 16 * 1024;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
class ProfileError extends Error { constructor(readonly code: LiveVoiceProfileError) { super(code); } }
function fail(code: LiveVoiceProfileError): never { throw new ProfileError(code); }
const failure = (error: unknown): Extract<LiveVoiceProfileResult, { ok: false }> => ({ ok: false, error: error instanceof ProfileError ? error.code : 'storage' });
type RecordData = { schemaVersion: 1; petID: string; role: LiveVoiceProfileTarget['role']; package: PackageReference; revision: number; referenceTranscript: string; reference: { file: string; sha256: string } | null };
type Loaded = { row: RecordData; source?: { info: Stats; bytes: Buffer }; audio?: { info: Stats; bytes: Buffer } };
type OwnedReference = { file: string; info: Stats };
type Options = {
  workspace: Pick<PetWorkspace, 'withRegisteredInstance'>;
  bindings: Pick<LiveRoleBindingStore, 'read'>;
  shares?: Pick<LiveShareStore, 'manage'>;
  io?: { rename?: typeof rename; syncDirectory?: () => Promise<void> };
};
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function cancelled(signal?: AbortSignal) { if (signal?.aborted) fail('cancelled'); }

/** A service-owned store rooted at <business-root>/live. Never consults speech/ or another pet. */
export class LiveVoiceProfileStore {
  private readonly base: PrivateDirectory;
  private readonly voices: PrivateDirectory;
  private readonly directories = new Map<string, PrivateDirectory>();
  private readonly uncertain = new Set<string>();
  private readonly pendingReferences = new Map<string, OwnedReference[]>();
  private readonly active = new Set<{ petID: string; abort: AbortController }>();
  private readonly jobs = new Set<Promise<unknown>>();
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(liveRoot: string, private readonly options: Options) {
    this.base = new PrivateDirectory(liveRoot); this.voices = new PrivateDirectory(join(liveRoot, 'voices'));
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new ProfileError('unavailable'));
    const result = this.tail.then(() => { if (this.closed) fail('unavailable'); return operation(); });
    this.tail = result.catch(() => {}); return result;
  }
  private async directory(petID: string): Promise<PrivateDirectory> {
    await this.base.ready(); await this.voices.ready();
    let directory = this.directories.get(petID);
    if (!directory) { directory = new PrivateDirectory(join(this.voices.root, petID)); this.directories.set(petID, directory); }
    await directory.ready(); return directory;
  }
  private async binding(target: LiveVoiceProfileTarget, pack: PackageReference, signal?: AbortSignal) {
    cancelled(signal); if (this.closed) fail('unavailable');
    const snapshot = await this.options.bindings.read();
    if (snapshot.revision !== target.bindingRevision || snapshot.bindings[target.role] !== target.petID || liveRoleForPackage(pack) !== target.role) fail('unbound');
    cancelled(signal);
  }
  private async context<T>(target: LiveVoiceProfileTarget, signal: AbortSignal | undefined, operation: (directory: PrivateDirectory, pack: PackageReference, check: () => Promise<void>) => Promise<T>): Promise<T> {
    try {
      cancelled(signal);
      return await this.options.workspace.withRegisteredInstance(target.petID, async (id, instance) => {
        cancelled(signal);
        if (id !== target.petID || instance.id !== id) fail('unbound');
        const work = async () => {
          const check = () => this.binding(target, instance.package, signal);
          await check();
          const result = await operation(await this.directory(id), instance.package, check);
          await check();
          return result;
        };
        // Same lock order as role bindings and persona context. In particular,
        // an unbind with no instance lock cannot slip past the commit check.
        return this.options.shares ? this.options.shares.manage(work) : work();
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) {
        if (error.code === 'not-found') fail('unbound');
        if (error.code === 'unavailable') fail('unavailable');
      }
      throw error;
    }
  }
  private snapshot(target: LiveVoiceProfileTarget, row: RecordData): LiveVoiceProfileSnapshot {
    return { role: target.role, petID: target.petID, bindingRevision: target.bindingRevision, revision: row.revision, hasReference: !!row.reference, referenceTranscript: row.referenceTranscript, ready: !!row.reference && !!row.referenceTranscript.trim() };
  }
  private async load(directory: PrivateDirectory, target: LiveVoiceProfileTarget, pack: PackageReference): Promise<Loaded> {
    const source = await directory.read(profileFile, metadataLimit);
    if (!source) return { row: { schemaVersion: 1, petID: target.petID, role: target.role, package: { ...pack }, revision: 0, referenceTranscript: '', reference: null } };
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source.bytes));
    if (!exact(value, ['schemaVersion', 'petID', 'role', 'package', 'revision', 'referenceTranscript', 'reference']) || value.schemaVersion !== 1 ||
      !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || !isSpeechTranscriptInput({ referenceTranscript: value.referenceTranscript }) ||
      !exact(value.package, ['id', 'version']) || (value.reference !== null && (!exact(value.reference, ['file', 'sha256']) || typeof value.reference.file !== 'string' ||
        !/^reference-[a-f0-9]{24}\.wav$/.test(value.reference.file) || typeof value.reference.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.reference.sha256))) ||
      (value.reference === null && value.referenceTranscript !== '')) fail('storage');
    if (value.petID !== target.petID || value.role !== target.role || value.package.id !== pack.id || value.package.version !== pack.version) fail('unbound');
    const row = value as RecordData;
    if (!row.reference) return { row, source };
    const audio = await directory.read(row.reference.file, referenceAudioLimit);
    if (!audio || !isReferenceAudio(audio.bytes) || digest(audio.bytes) !== row.reference.sha256) fail('storage');
    return { row, source, audio };
  }
  read(target: LiveVoiceProfileTarget, signal?: AbortSignal): Promise<LiveVoiceProfileResult> {
    return this.readProfile(target, signal, true);
  }
  /** Background stage lookups must not reconcile an uncertain write. */
  readForStage(target: LiveVoiceProfileTarget, signal?: AbortSignal): Promise<LiveVoiceProfileResult> {
    return this.readProfile(target, signal, false);
  }
  private readProfile(target: LiveVoiceProfileTarget, signal: AbortSignal | undefined, reconcile: boolean): Promise<LiveVoiceProfileResult> {
    if (!isLiveVoiceProfileTarget(target)) return Promise.resolve({ ok: false, error: 'invalid' });
    return this.run(async () => {
      try {
        const result = await this.context(target, signal, async (directory, pack, check) => {
          if (!this.uncertain.has(target.petID)) return this.snapshot(target, (await this.load(directory, target, pack)).row);
          if (!reconcile) fail('storage');
          return this.withWriteLock(directory, async () => {
            const loaded = await this.load(directory, target, pack);
            await directory.sync(); await this.options.io?.syncDirectory?.(); await check();
            await this.removeSuperseded(directory, target.petID, loaded.row.reference?.file);
            return this.snapshot(target, loaded.row);
          });
        });
        // Only an explicit, verified reread reconciles an ambiguous write.
        this.uncertain.delete(target.petID);
        return { ok: true as const, profile: result };
      } catch (error) {
        const result = failure(error);
        if (result.error === 'storage') this.uncertain.add(target.petID);
        return result;
      }
    }).catch(failure);
  }
  private invalidate(petID: string) { for (const job of this.active) if (job.petID === petID) job.abort.abort(); }
  private async source(path: string): Promise<Buffer> {
    if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || path.includes('\0') || path.split(sep).some(part => part === '.' || part === '..')) fail('invalid');
    const ancestors = async () => {
      const result: Stats[] = []; let current = parse(path).root;
      for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
        current = join(current, part); const info = await lstat(current);
        if (info.isSymbolicLink()) fail('invalid'); result.push(info);
      }
      return result;
    };
    try {
      const before = await ancestors(), bytes = await readReferenceAudio(path), after = await ancestors();
      if (before.length !== after.length || before.some((info, i) => !sameFile(info, after[i]!) || (info.isFile() && info.ctimeMs !== after[i]!.ctimeMs))) fail('invalid');
      return bytes;
    } catch { return fail('invalid'); }
  }
  selectReference(input: LiveVoiceProfileMutation, path: string, signal?: AbortSignal): Promise<LiveVoiceProfileResult> {
    if (!isLiveVoiceProfileMutation(input)) return Promise.resolve({ ok: false, error: 'invalid' });
    return this.mutate(input, signal, async () => ({ audio: await this.source(path), transcript: '' }));
  }
  saveTranscript(input: LiveVoiceTranscriptInput, signal?: AbortSignal): Promise<LiveVoiceProfileResult> {
    if (!isLiveVoiceTranscriptInput(input)) return Promise.resolve({ ok: false, error: 'invalid' });
    return this.mutate(input, signal, async old => {
      if (!old.audio) fail('reference-required'); return { audio: old.audio.bytes, transcript: input.referenceTranscript, keepReference: true };
    });
  }
  clearReference(input: LiveVoiceProfileMutation, signal?: AbortSignal): Promise<LiveVoiceProfileResult> {
    if (!isLiveVoiceProfileMutation(input)) return Promise.resolve({ ok: false, error: 'invalid' });
    return this.mutate(input, signal, async () => ({ transcript: '' }));
  }
  private async withWriteLock<T>(directory: PrivateDirectory, operation: () => Promise<T>): Promise<T> {
    let lock: FileHandle | undefined, identity: Stats | undefined;
    try {
      try { lock = await directory.create(lockFile); } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
          if (await directory.file(lockFile)) fail('conflict');
        }
        throw error;
      }
      identity = await lock.stat(); await lock.close(); lock = undefined;
      return await operation();
    } finally { await lock?.close(); if (identity) await directory.removeOwned(lockFile, identity); }
  }
  private async removeSuperseded(directory: PrivateDirectory, petID: string, current: string | undefined): Promise<void> {
    const superseded = (this.pendingReferences.get(petID) ?? []).filter(ref => ref.file !== current);
    for (const ref of superseded) await directory.removeOwned(ref.file, ref.info);
    if (superseded.length) await directory.sync();
    this.pendingReferences.delete(petID);
  }
  private mutate(input: LiveVoiceProfileMutation, signal: AbortSignal | undefined, change: (old: Loaded) => Promise<{ audio?: Buffer; transcript: string; keepReference?: boolean }>): Promise<LiveVoiceProfileResult> {
    return this.run(async () => {
      let publishing = false;
      try {
        const profile = await this.context(input, signal, async (directory, pack, check) => {
          if (this.uncertain.has(input.petID)) fail('storage');
          return this.withWriteLock(directory, async () => {
            const old = await this.load(directory, input, pack);
            if (old.row.revision !== input.expectedRevision || old.row.revision === Number.MAX_SAFE_INTEGER) fail('conflict');
            const changed = await change(old); await check();
            this.invalidate(input.petID);
            const next: RecordData = { ...old.row, revision: old.row.revision + 1, referenceTranscript: changed.transcript, reference: null };
            const owned: OwnedReference[] = old.row.reference && old.audio ? [{ file: old.row.reference.file, info: old.audio.info }] : [];
            const temporary = `.profile-${randomBytes(12).toString('hex')}.tmp`;
            let tempIdentity: Stats | undefined;
            try {
              if (changed.keepReference) next.reference = old.row.reference;
              else if (changed.audio) {
                const file = `reference-${randomBytes(12).toString('hex')}.wav`;
                owned.push({ file, info: await this.writeFile(directory, file, changed.audio) });
                await directory.sync(); next.reference = { file, sha256: digest(changed.audio) };
              }
              this.pendingReferences.set(input.petID, owned);
              tempIdentity = await this.writeFile(directory, temporary, Buffer.from(JSON.stringify(next)));
              const latest = await directory.file(profileFile);
              if (old.source ? !latest || !sameFile(latest, old.source.info) || latest.ctimeMs !== old.source.info.ctimeMs : !!latest) fail('conflict');
              await check(); publishing = true;
              await (this.options.io?.rename ?? rename)(directory.path(temporary), directory.path(profileFile));
              await directory.sync(); await this.options.io?.syncDirectory?.(); await check();
              await this.removeSuperseded(directory, input.petID, next.reference?.file);
              return this.snapshot(input, next);
            } finally {
              if (tempIdentity) await directory.removeOwned(temporary, tempIdentity);
              if (!publishing) {
                this.pendingReferences.set(input.petID, owned);
                await this.removeSuperseded(directory, input.petID, old.row.reference?.file);
              }
            }
          });
        });
        return { ok: true as const, profile };
      } catch (error) {
        const result = failure(error);
        if (publishing || result.error === 'storage') this.uncertain.add(input.petID);
        return result;
      }
    }).catch(failure);
  }
  private async writeFile(directory: PrivateDirectory, name: string, bytes: Buffer): Promise<Stats> {
    const handle = await directory.create(name);
    let identity: Stats | undefined, complete = false;
    try {
      identity = await handle.stat(); await handle.writeFile(bytes); await handle.sync(); complete = true;
      return identity;
    } finally {
      await handle.close();
      if (!complete && identity) await directory.removeOwned(name, identity);
    }
  }
  private async capture(input: LiveVoiceProfileMutation, signal: AbortSignal): Promise<SpeechProfileInput> {
    cancelled(signal);
    const lookup = this.run(() => this.context(input, signal, async (directory, pack) => {
      if (this.uncertain.has(input.petID)) fail('storage');
      const loaded = await this.load(directory, input, pack);
      if (loaded.row.revision !== input.expectedRevision) fail('conflict');
      if (!loaded.audio || !loaded.row.referenceTranscript.trim()) fail('reference-required');
      return { audio: loaded.audio.bytes, transcript: loaded.row.referenceTranscript };
    }));
    // Pause can hold the workspace queue while draining speech. Stop waiting on
    // an aborted read; its queued callback checks the same signal before I/O.
    let abort!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new ProfileError('cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    try { return await Promise.race([lookup, interrupted]); }
    finally { signal.removeEventListener('abort', abort); }
  }
  private synthesize<T>(input: LiveVoiceProfileMutation, signal: AbortSignal, eligible: () => boolean, render: (profile: SpeechProfileInput, owned: AbortSignal, current: () => boolean, recheck: (stageSignal?: AbortSignal) => Promise<void>) => Promise<T>): Promise<{ ok: true; value: T } | Extract<LiveVoiceResult, { ok: false }>> {
    const abort = new AbortController(), job = { petID: input.petID, abort }, cancel = () => abort.abort();
    signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel(); this.active.add(job);
    const current = () => !this.closed && !abort.signal.aborted && eligible();
    const task = (async () => {
      try {
        if (!isLiveVoiceProfileMutation(input) || !current()) fail('cancelled');
        const profile = await this.capture(input, abort.signal);
        if (!current()) fail('cancelled');
        const recheck = async (stageSignal?: AbortSignal) => {
          if (!current()) fail('cancelled');
          const latest = await this.capture(input, stageSignal ? AbortSignal.any([abort.signal, stageSignal]) : abort.signal);
          if (!current() || latest.transcript !== profile.transcript || !latest.audio.equals(profile.audio)) fail('conflict');
        };
        const value = await render(profile, abort.signal, current, recheck);
        await recheck();
        return { ok: true as const, value };
      } catch (error) { return { ok: false as const, error: error instanceof ProfileError && error.code === 'reference-required' ? 'reference-required' as const : 'voice-failed' as const }; }
      finally { signal.removeEventListener('abort', cancel); this.active.delete(job); }
    })();
    this.jobs.add(task); void task.finally(() => this.jobs.delete(task)); return task;
  }
  async prepareStageVoice(input: LiveVoiceProfileMutation, speech: BubbleSpeech, signal: AbortSignal, eligible: () => boolean): Promise<LiveVoiceResult> {
    const result = await this.synthesize(input, signal, eligible, (profile, owned, current, recheck) => speech.prepareStageVoiceWithReference(profile, input.role, owned, current, recheck));
    return result.ok ? result.value : result;
  }
  async prepareStageReply(input: LiveVoiceProfileMutation, speech: BubbleSpeech, text: string, signal: AbortSignal, eligible: () => boolean): Promise<Buffer | undefined> {
    const result = await this.synthesize(input, signal, eligible, (profile, owned, current) => speech.prepareStageReplyWithReference(profile, text, owned, current));
    return result.ok ? result.value : undefined;
  }
  async close(): Promise<void> {
    this.closed = true; for (const job of this.active) job.abort.abort();
    await Promise.allSettled([this.tail, ...this.jobs]);
  }
}
