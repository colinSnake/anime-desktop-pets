import { isLiveDanmakuReply, isLiveRoleId, liveActionIds, type LiveRoleId } from '../../../../packages/contracts/src/live-stage.ts';
import { liveVoiceLines, stageVoiceDuration, type LiveVoiceBank, type LiveVoiceResult } from '../../../../packages/contracts/src/live-voice.ts';
import { speechPreviewPhrase, type SpeechPreviewCommand, isSpeechEnableInput, isSpeechTranscriptInput, type SpeechResult, type SpeechRuntimeReadiness, type SpeechStatus } from '../../../../packages/contracts/src/speech.ts';
import type { VideoSpeechState } from '../workspace-video-protocol.ts';
import { isCue } from './cue.ts';
import { isReferenceAudio, readReferenceAudio } from './reference-audio.ts';
import type { SpeechProfile, SpeechProfileStore } from './profile-store.ts';

export type SpeechTask = { text: string; audio: Buffer; transcript: string; signal: AbortSignal; resolveStatus(state: 'loading' | 'speaking'): void };
export type SpeechProfileInput = Pick<SpeechTask, 'audio' | 'transcript'>;
export type SpeechBackend = {
  run(task: SpeechTask): Promise<void>; prepare?(profile: SpeechProfileInput): void;
  renderStage?(profile: SpeechProfileInput, signal: AbortSignal): Promise<LiveVoiceBank>;
  renderStageReply?(profile: SpeechProfileInput, text: string, signal: AbortSignal): Promise<Buffer>;
  readiness?(): SpeechRuntimeReadiness; close(): Promise<void>;
};
type Cue = { source: symbol; text: string; eligible: () => boolean; report?: (state: VideoSpeechState) => void };

/** One playback and one latest candidate across all owned players. */
export class BubbleSpeech {
  private reference?: Buffer;
  private transcript?: string;
  private savedTranscript?: string;
  private savedEnabled = false;
  private storageUnavailable = false;
  private pending?: Cue;
  private current?: { cue: Cue; abort: AbortController };
  private state: SpeechStatus['state'] = 'disabled';
  private selecting = false;
  private profileWrite?: Promise<void>;
  private suspending?: Promise<void>;
  private stoppingSource?: symbol;
  private stopUnconfirmed = false;
  private voiceDraftSuspended = false;
  private closed = false;
  private stageRender?: { abort: AbortController; task: Promise<unknown> };
  private previewRevision = 0;
  private readonly previewSource = Symbol('local-preview');

  constructor(private backend: SpeechBackend, private readonly profile?: SpeechProfileStore) {}

  async restoreProfile(): Promise<void> {
    try {
      const saved = await this.profile?.read();
      this.reference = saved?.audio;
      this.savedTranscript = saved?.transcript;
      this.savedEnabled = saved?.enabled === true;
      if (this.reference && this.savedEnabled && this.savedTranscript !== undefined) {
        this.transcript = this.savedTranscript;
        this.state = 'enabled';
        try { this.backend.prepare?.({ audio: this.reference, transcript: this.savedTranscript }); }
        catch { this.transcript = undefined; this.state = 'failed'; }
      }
    } catch { this.storageUnavailable = true; }
  }

  private async saveProfile(profile?: SpeechProfile): Promise<boolean> {
    if (!this.profile) return true;
    const previous = this.profileWrite;
    const write = (previous ?? Promise.resolve()).then(() => this.profile!.write(profile));
    this.profileWrite = write;
    try { await write; return true; }
    catch {
      // A publication may have reached disk even if durability was not confirmed.
      // Do not tell the renderer the old or new version is authoritative.
      this.storageUnavailable = true;
      return false;
    } finally { if (this.profileWrite === write) this.profileWrite = undefined; }
  }
  status(): SpeechStatus {
    const previewing = this.current?.cue.source === this.previewSource || this.stoppingSource === this.previewSource;
    const hasReference = !!this.reference && !this.storageUnavailable;
    const runtime = hasReference && this.transcript && !this.closed ? this.backend.readiness?.() : undefined;
    return { state: this.closed || this.storageUnavailable ? 'unavailable' : this.state, hasReference,
      previewAvailable: true,
      ...(runtime ? { runtime } : {}),
      ...(this.storageUnavailable ? { storageUnavailable: true } : {}),
      ...(hasReference && this.savedTranscript !== undefined ? { referenceTranscript: this.savedTranscript } : {}),
      ...(previewing ? { previewing: true } : {}),
    };
  }
  private ok(): SpeechResult { return { ok: true, speech: this.status() }; }

  async select(path: string): Promise<SpeechResult> {
    if (this.closed) return { ok: false, error: 'unavailable' };
    if (this.storageUnavailable) return { ok: false, error: 'storage' };
    if (this.stageRender || this.selecting || this.transcript || this.suspending || this.stopUnconfirmed || this.voiceDraftSuspended || this.current) return { ok: false, error: 'busy' };
    this.selecting = true;
    try {
      let audio: Buffer;
      try { audio = await readReferenceAudio(path); }
      catch { return { ok: false, error: 'invalid-audio' }; }
      if (this.closed) return { ok: false, error: 'unavailable' };
      // A re-selection of the same bytes need not discard the saved text.
      const transcript = this.reference?.equals(audio) ? this.savedTranscript : undefined;
      if (!await this.saveProfile({ audio, transcript, enabled: false })) return { ok: false, error: 'storage' };
      if (this.closed) return { ok: false, error: 'unavailable' };
      this.reference = audio; this.savedTranscript = transcript; this.savedEnabled = false;
      return this.ok();
    } finally { this.selecting = false; }
  }

  async clearReference(): Promise<SpeechResult> {
    if (this.closed) return { ok: false, error: 'unavailable' };
    if (this.storageUnavailable) return { ok: false, error: 'storage' };
    if (this.stageRender || this.selecting || this.transcript || this.suspending || this.stopUnconfirmed || this.voiceDraftSuspended || this.current) return { ok: false, error: 'busy' };
    this.selecting = true;
    try {
      if (!await this.saveProfile()) return { ok: false, error: 'storage' };
      this.reference = this.savedTranscript = undefined; this.savedEnabled = false;
      return this.ok();
    } finally { this.selecting = false; }
  }

  async saveTranscriptDraft(transcript: string): Promise<SpeechResult> {
    if (this.closed) return { ok: false, error: 'unavailable' };
    if (this.storageUnavailable) return { ok: false, error: 'storage' };
    if (!isSpeechTranscriptInput({ referenceTranscript: transcript })) return { ok: false, error: 'invalid' };
    if (!this.reference) return { ok: false, error: 'reference-required' };
    if (this.stageRender || this.selecting || this.transcript || this.suspending || this.stopUnconfirmed || this.voiceDraftSuspended || this.current) return { ok: false, error: 'busy' };
    this.selecting = true;
    try {
      if (this.savedTranscript === transcript && !this.savedEnabled) return this.ok();
      if (!await this.saveProfile({ audio: this.reference, transcript, enabled: false })) return { ok: false, error: 'storage' };
      if (this.closed) return { ok: false, error: 'unavailable' };
      this.savedTranscript = transcript; this.savedEnabled = false;
      return this.ok();
    } finally { this.selecting = false; }
  }

  async enable(transcript: string): Promise<SpeechResult> {
    if (this.closed) return { ok: false, error: 'unavailable' };
    if (this.storageUnavailable) return { ok: false, error: 'storage' };
    if (this.stageRender || this.selecting || this.suspending || this.stopUnconfirmed || this.voiceDraftSuspended || this.current || this.transcript) return { ok: false, error: 'busy' };
    if (!isSpeechEnableInput({ referenceTranscript: transcript })) return { ok: false, error: 'invalid' };
    if (!this.reference) return { ok: false, error: 'reference-required' };
    this.selecting = true;
    try {
      const saved = transcript.trim();
      if (this.profile && (saved !== this.savedTranscript || !this.savedEnabled) &&
          !await this.saveProfile({ audio: this.reference, transcript: saved, enabled: true })) return { ok: false, error: 'storage' };
      if (this.closed) return { ok: false, error: 'unavailable' };
      this.savedTranscript = saved; this.savedEnabled = true;
      this.transcript = saved; this.state = 'enabled';
      this.backend.prepare?.({ transcript: saved, audio: this.reference });
      return this.ok();
    } finally { this.selecting = false; }
  }

  async disable(): Promise<SpeechResult> {
    if (this.closed) return { ok: false, error: 'unavailable' };
    if (this.stageRender || this.selecting) return { ok: false, error: 'busy' };
    this.selecting = true;
    this.transcript = undefined;
    let stopFailed = false;
    try { await this.pause(); } catch { stopFailed = true; }
    try {
      if (this.reference && !await this.saveProfile({ audio: this.reference, transcript: this.savedTranscript, enabled: false }))
        return { ok: false, error: 'storage' };
      this.savedEnabled = false;
      return stopFailed ? { ok: false, error: 'unavailable' } : this.ok();
    } finally { this.selecting = false; }
  }

  async suspendForVoiceDraft(): Promise<SpeechResult> {
    if (this.closed) return { ok: false, error: 'unavailable' };
    if (this.voiceDraftSuspended) return this.ok();
    if (this.stageRender || this.selecting || this.stopUnconfirmed) return { ok: false, error: 'busy' };
    this.voiceDraftSuspended = true;
    try {
      await this.pause();
      return this.closed ? { ok: false, error: 'unavailable' } : this.ok();
    } catch { return { ok: false, error: 'unavailable' }; }
  }

  resumeAfterVoiceDraft(preload: boolean): SpeechResult {
    if (this.closed) return { ok: false, error: 'unavailable' };
    if (!this.voiceDraftSuspended) return this.ok();
    this.voiceDraftSuspended = false;
    if (preload && this.transcript && this.reference && !this.stopUnconfirmed) {
      try { this.backend.prepare?.({ audio: this.reference, transcript: this.transcript }); }
      catch { this.state = 'failed'; this.transcript = undefined; return { ok: false, error: 'unavailable' }; }
    }
    this.runNext();
    return this.ok();
  }

  async prepareStageVoice(signal: AbortSignal, eligible: () => boolean): Promise<LiveVoiceResult> {
    if (!this.backend.renderStage) return {ok:false,error:'voice-failed'};
    const result = await this.renderStage(signal, eligible, (profile, owned) => this.backend.renderStage!(profile,owned));
    return result.ok ? {ok:true,clips:result.value} : result;
  }

  async prepareStageReply(text: string, signal: AbortSignal, eligible: () => boolean): Promise<Buffer | undefined> {
    if (!this.backend.renderStageReply || !isLiveDanmakuReply(text)) return;
    const result = await this.renderStage(signal, eligible, (profile, owned) => this.backend.renderStageReply!(profile,text,owned));
    if (result.ok && stageVoiceDuration(result.value)) return result.value;
  }

  /** Explicit live-only input: never reads, prepares, or persists the desktop speech profile. */
  async prepareStageVoiceWithReference(reference: SpeechProfileInput | undefined, role: LiveRoleId, signal: AbortSignal, eligible: () => boolean, recheck?: (signal: AbortSignal) => Promise<void>): Promise<LiveVoiceResult> {
    if (!isLiveRoleId(role) || !this.backend.renderStageReply) return { ok: false, error: 'voice-failed' };
    const result = await this.renderStage(signal, eligible, async (profile, owned) => {
      const clips = {} as LiveVoiceBank;
      for (const slot of liveActionIds) {
        await recheck?.(owned);
        owned.throwIfAborted();
        if (!eligible()) throw new Error('stage_ineligible');
        const clip = await this.backend.renderStageReply!(profile, liveVoiceLines[role][slot], owned);
        owned.throwIfAborted();
        if (!eligible() || !stageVoiceDuration(clip)) throw new Error('stage_voice_invalid');
        clips[slot] = clip;
      }
      return clips;
    }, reference, true);
    return result.ok ? { ok: true, clips: result.value } : result;
  }

  async prepareStageReplyWithReference(reference: SpeechProfileInput | undefined, text: string, signal: AbortSignal, eligible: () => boolean): Promise<Buffer | undefined> {
    if (!this.backend.renderStageReply || !isLiveDanmakuReply(text)) return;
    const result = await this.renderStage(signal, eligible, (profile, owned) => this.backend.renderStageReply!(profile, text, owned), reference, true);
    if (result.ok && stageVoiceDuration(result.value)) return result.value;
  }

  private async renderStage<T>(signal: AbortSignal, eligible: () => boolean, render: (profile: SpeechProfileInput, owned: AbortSignal) => Promise<T>, explicit?: SpeechProfileInput, liveOnly = false):
    Promise<{ok:true;value:T} | Extract<LiveVoiceResult,{ok:false}>> {
    if (this.closed || (!liveOnly && this.storageUnavailable) || signal.aborted) return {ok:false,error:'voice-failed'};
    if (!eligible() || this.stageRender || this.selecting || this.suspending || this.stopUnconfirmed || this.voiceDraftSuspended || this.current || this.pending)
      return {ok:false,error:'voice-busy'};
    const reference = liveOnly ? explicit?.audio : this.reference;
    const savedTranscript = liveOnly ? explicit?.transcript : this.savedTranscript;
    if (!reference || !savedTranscript?.trim()) return {ok:false,error:'reference-required'};
    if (liveOnly && (!isReferenceAudio(reference) || !isSpeechEnableInput({ referenceTranscript: savedTranscript }))) return {ok:false,error:'voice-failed'};
    const captured = { audio: liveOnly ? Buffer.from(reference) : reference, transcript: savedTranscript };
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal.addEventListener('abort', cancel, {once:true});
    const task = Promise.resolve().then(() => {
      abort.signal.throwIfAborted();
      if (this.closed || !eligible()) throw new Error('stage_ineligible');
      return render(captured,abort.signal);
    });
    this.stageRender = {abort,task};
    try {
      const value = await task;
      return abort.signal.aborted || !eligible() || this.closed ? {ok:false,error:'voice-failed'} : {ok:true,value};
    } catch { return {ok:false,error:'voice-failed'}; }
    finally { signal.removeEventListener('abort',cancel); this.stageRender = undefined; this.runNext(); }
  }

  async preview(command: SpeechPreviewCommand, eligible: () => boolean): Promise<SpeechResult> {
    if (this.closed || command.revision <= this.previewRevision) return { ok: false, error: 'unavailable' };
    this.previewRevision = command.revision;
    if (!command.play) {
      try { await this.cancelSource(this.previewSource); return this.ok(); }
      catch { return { ok: false, error: 'unavailable' }; }
    }
    if (!eligible()) return { ok: false, error: 'busy' };
    if (this.stageRender || this.selecting || this.suspending || this.stopUnconfirmed || this.voiceDraftSuspended || this.current || this.pending) return { ok: false, error: 'busy' };
    if (!this.transcript || !this.reference) return { ok: false, error: 'reference-required' };
    return this.offer(this.previewSource, speechPreviewPhrase, () => command.revision === this.previewRevision && eligible())
      ? this.ok() : { ok: false, error: 'unavailable' };
  }

  offer(source: symbol, text: string, eligible: () => boolean, report?: Cue['report']) {
    if (this.stageRender || !this.transcript || !this.reference || this.closed || this.suspending || this.stopUnconfirmed || this.voiceDraftSuspended || !isCue(text) || !eligible()) return false;
    this.dropPending();
    this.pending = { source, text, eligible, report };
    report?.('held');
    this.runNext();
    return true;
  }

  private dropPending() {
    const cue = this.pending;
    this.pending = undefined;
    cue?.report?.('released');
  }

  cancelSource(source: symbol) {
    if (this.pending?.source === source) this.dropPending();
    if (this.current?.cue.source !== source && this.stoppingSource !== source) return Promise.resolve();
    return this.stopPlayback();
  }

  async pause(): Promise<void> {
    this.dropPending();
    const render = this.stageRender;
    render?.abort.abort();
    await Promise.all([this.stopPlayback(), render?.task.catch(() => {})]);
  }

  private stopPlayback(): Promise<void> {
    if (this.current) {
      this.stoppingSource = this.current.cue.source;
      this.current.abort.abort();
    }
    if (!this.suspending) {
      this.suspending = Promise.resolve().then(() => this.backend.close()).then(() => {
        this.stoppingSource = undefined;
        this.stopUnconfirmed = false;
        this.state = this.transcript ? 'enabled' : 'disabled';
      }, error => {
        this.stopUnconfirmed = true;
        this.state = 'failed'; this.transcript = undefined; this.dropPending();
        throw error;
      }).finally(() => { this.suspending = undefined; this.runNext(); });
    }
    return this.suspending;
  }
  async close() {
    this.closed = true; this.transcript = undefined; this.reference = undefined; this.savedTranscript = undefined;
    await Promise.all([this.pause(), this.profileWrite?.catch(() => {})]);
  }

  private runNext() {
    if (this.stageRender || this.current || !this.transcript || !this.reference || this.suspending || this.stopUnconfirmed || this.voiceDraftSuspended || this.closed) return;
    const cue = this.pending;
    this.pending = undefined;
    if (!cue) return;
    if (!cue.eligible()) { cue.report?.('released'); return; }
    const current = { cue, abort: new AbortController() };
    this.current = current;
    this.state = 'loading';
    const { signal } = current.abort;
    void (async () => {
      let drained = false;
      try {
        await this.backend.run({ text: cue.text, transcript: this.transcript!, audio: this.reference!, signal,
          resolveStatus: status => { if (!signal.aborted && this.current === current) this.state = status; } });
        if (!signal.aborted) { this.state = 'enabled'; drained = true; }
      } catch {
        if (!signal.aborted) {
          this.state = 'failed'; this.transcript = undefined; this.dropPending();
          this.stoppingSource = cue.source; this.stopUnconfirmed = true;
        }
      } finally {
        if (this.current === current) this.current = undefined;
        cue.report?.(drained ? 'drained' : 'released');
        this.runNext();
      }
    })();
  }
}
