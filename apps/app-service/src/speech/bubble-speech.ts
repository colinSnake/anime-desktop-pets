import { isSpeechEnableInput, type ReplySpeechCommand, type SpeechResult, type SpeechStatus } from '../../../../packages/contracts/src/speech.ts';
import { isCue } from './cue.ts';
import { readReferenceAudio } from './reference-audio.ts';

export type SpeechTask = { text: string; audio: Buffer; transcript: string; signal: AbortSignal; resolveStatus(state: 'loading' | 'speaking'): void };
export type SpeechBackend = { run(task: SpeechTask): Promise<void>; close(): Promise<void> };
type Cue = { source: symbol; text: string; eligible: () => boolean };

/** One playback and one latest candidate across all owned players. */
export class BubbleSpeech {
  private reference?: Buffer;
  private transcript?: string;
  private pending?: Cue;
  private current?: { cue: Cue; abort: AbortController };
  private state: SpeechStatus['state'] = 'disabled';
  private selecting = false;
  private suspending?: Promise<void>;
  private stoppingSource?: symbol;
  private stopUnconfirmed = false;
  private closed = false;
  private replyRevision = 0;
  private readonly replySource = Symbol('chat-reply');
  private speakChatReplies = false;

  constructor(private backend: SpeechBackend) {}
  status(): SpeechStatus { return { state: this.closed ? 'unavailable' : this.state, hasReference: !!this.reference, ...(this.transcript && this.speakChatReplies ? { speakChatReplies: true } : {}) }; }
  private ok(): SpeechResult { return { ok: true, speech: this.status() }; }

  async select(path: string): Promise<SpeechResult> {
    if (this.closed) return { ok: false, error: 'unavailable' };
    if (this.selecting || this.transcript || this.suspending || this.stopUnconfirmed || this.current) return { ok: false, error: 'busy' };
    this.selecting = true;
    try {
      const reference = await readReferenceAudio(path);
      if (this.closed) return { ok: false, error: 'unavailable' };
      this.reference = reference;
      return this.ok();
    } catch { return { ok: false, error: 'invalid-audio' }; }
    finally { this.selecting = false; }
  }

  clearReference(): SpeechResult {
    if (this.closed) return { ok: false, error: 'unavailable' };
    if (this.selecting || this.transcript || this.suspending || this.stopUnconfirmed || this.current) return { ok: false, error: 'busy' };
    this.reference = undefined;
    return this.ok();
  }

  enable(transcript: string, speakChatReplies = false): SpeechResult {
    if (this.closed) return { ok: false, error: 'unavailable' };
    if (this.selecting || this.suspending || this.stopUnconfirmed || this.current || this.transcript) return { ok: false, error: 'busy' };
    if (!isSpeechEnableInput({ referenceTranscript: transcript })) return { ok: false, error: 'invalid' };
    if (!this.reference) return { ok: false, error: 'reference-required' };
    this.transcript = transcript.trim(); this.speakChatReplies = speakChatReplies; this.state = 'enabled';
    return this.ok();
  }

  async disable(): Promise<SpeechResult> {
    if (this.closed) return { ok: false, error: 'unavailable' };
    this.transcript = undefined; this.speakChatReplies = false;
    try { await this.pause(); return this.ok(); }
    catch { return { ok: false, error: 'unavailable' }; }
  }

  async reply(command: ReplySpeechCommand, eligible: () => boolean): Promise<SpeechResult> {
    // A stop that passes a delayed HTTP offer must never let that offer restart audio.
    if (this.closed || command.revision <= this.replyRevision) return { ok: false, error: 'unavailable' };
    this.replyRevision = command.revision;
    if (command.text === undefined) {
      try { await this.cancelSource(this.replySource); return this.ok(); }
      catch { return { ok: false, error: 'unavailable' }; }
    }
    // Chat is best-effort and cannot replace an already queued interaction bubble.
    if (!this.speakChatReplies || (this.pending && this.pending.source !== this.replySource)) return { ok: false, error: 'unavailable' };
    return this.offer(this.replySource, command.text, () => this.speakChatReplies && this.replyRevision === command.revision && eligible())
      ? this.ok() : { ok: false, error: 'unavailable' };
  }

  offer(source: symbol, text: string, eligible: () => boolean) {
    if (!this.transcript || !this.reference || this.closed || this.suspending || this.stopUnconfirmed || !isCue(text) || !eligible()) return false;
    this.pending = { source, text, eligible };
    this.runNext();
    return true;
  }

  cancelSource(source: symbol) {
    if (this.pending?.source === source) this.pending = undefined;
    if (this.current?.cue.source !== source && this.stoppingSource !== source) return Promise.resolve();
    return this.stopPlayback();
  }

  pause(): Promise<void> {
    this.pending = undefined;
    return this.stopPlayback();
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
        this.state = 'failed'; this.transcript = undefined; this.pending = undefined;
        throw error;
      }).finally(() => { this.suspending = undefined; this.runNext(); });
    }
    return this.suspending;
  }
  async close() {
    this.closed = true; this.transcript = undefined; this.reference = undefined;
    await this.pause();
  }

  private runNext() {
    if (this.current || !this.transcript || !this.reference || this.suspending || this.stopUnconfirmed || this.closed) return;
    const cue = this.pending;
    this.pending = undefined;
    if (!cue?.eligible()) return;
    const current = { cue, abort: new AbortController() };
    this.current = current;
    this.state = 'loading';
    const { signal } = current.abort;
    void (async () => {
      try {
        await this.backend.run({ text: cue.text, transcript: this.transcript!, audio: this.reference!, signal,
          resolveStatus: status => { if (!signal.aborted && this.current === current) this.state = status; } });
        if (!signal.aborted) this.state = 'enabled';
      } catch {
        if (!signal.aborted) {
          this.state = 'failed'; this.transcript = undefined; this.pending = undefined;
          this.stoppingSource = cue.source; this.stopUnconfirmed = true;
        }
      } finally {
        if (this.current === current) this.current = undefined;
        this.runNext();
      }
    })();
  }
}
