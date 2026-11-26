import { spawn } from 'node:child_process';
import { addAbortListener } from 'node:events';
import { readReferenceAudio } from '../../app-service/src/speech/reference-audio.ts';
import { validVoiceDraft, type VoiceDraftError, type VoiceDraftResult } from '../../../packages/contracts/src/voice-draft.ts';

type Failure = Extract<VoiceDraftResult, { ok: false }>;
const error = (code: VoiceDraftError): Failure => ({ ok: false, error: code });
const maxOutput = 4096;
const maxPendingReads = 2;
type Selection = { canceled: boolean; filePaths: string[] };
type TranscriptionRelease = () => Promise<unknown>;
type BeforeTranscribe = () => Promise<TranscriptionRelease | undefined>;

export class VoiceDraftPicker {
  private active?: { abort: AbortController; worker?: Promise<VoiceDraftResult> };
  private pendingReads = 0;
  constructor(private readonly transcribe: (audio: Buffer, signal: AbortSignal) => Promise<VoiceDraftResult>,
    private readonly options: { readAudio?: typeof readReferenceAudio; readTimeoutMs?: number } = {}) {}

  get busy() { return this.active !== undefined; }

  record(audio: Buffer, signal: AbortSignal, current: () => boolean): Promise<VoiceDraftResult> {
    if (this.active) return Promise.resolve(error('busy'));
    if (signal.aborted || !current()) return Promise.resolve(error('cancelled'));
    const abort = new AbortController();
    const onAbort = addAbortListener(signal, () => abort.abort());
    const operation: NonNullable<VoiceDraftPicker['active']> = { abort };
    this.active = operation;
    return (async () => {
      try {
        const result = await (operation.worker = this.transcribe(audio, abort.signal));
        return !abort.signal.aborted && current() ? result : error('cancelled');
      } catch { return error(abort.signal.aborted ? 'cancelled' : 'failed'); }
    })().finally(() => { onAbort[Symbol.dispose](); this.active = undefined; });
  }

  select(choose: () => Promise<Selection>, current: () => boolean, beforeTranscribe?: BeforeTranscribe): Promise<VoiceDraftResult> {
    if (this.active || this.pendingReads >= maxPendingReads) return Promise.resolve(error('busy'));
    if (!current()) return Promise.resolve(error('unavailable'));
    const abort = new AbortController();
    const eligible = () => !abort.signal.aborted && current();
    const operation: NonNullable<VoiceDraftPicker['active']> = { abort };
    this.active = operation;
    return (async () => {
      let release: TranscriptionRelease | undefined;
      try {
        const { canceled, filePaths } = await choose();
        if (!eligible() || canceled) return error('cancelled');
        if (filePaths.length !== 1 || !filePaths[0]) return error('invalid-file');
        const audio = await this.read(filePaths[0], abort.signal);
        if (!eligible()) return error('cancelled');
        if (!Buffer.isBuffer(audio)) return audio;
        if (beforeTranscribe) {
          release = await beforeTranscribe();
          if (!release) return error('unavailable');
          if (!eligible()) return error('cancelled');
        }
        const result = await (operation.worker = this.transcribe(audio, abort.signal));
        return eligible() ? result : error('cancelled');
      } catch { return eligible() ? error('failed') : error('cancelled'); }
      finally {
        try { await release?.(); } catch { /* Releasing TTS must not replace the ASR result. */ }
        this.active = undefined;
      }
    })();
  }

  private async read(path: string, signal: AbortSignal): Promise<Buffer | Failure> {
    if (signal.aborted) return error('cancelled');
    this.pendingReads++;
    // File I/O itself may not be interruptible. Allow a retry without releasing the
    // abandoned read's I/O slot until it really settles, and never forward its bytes.
    const actual = Promise.resolve().then(() => (this.options.readAudio ?? readReferenceAudio)(path))
      .catch(() => error('invalid-file')).finally(() => { this.pendingReads--; });
    let timeout: ReturnType<typeof setTimeout> | undefined, cancel: Disposable | undefined;
    const abandoned = new Promise<Failure>(resolve => {
      timeout = setTimeout(() => resolve(error('timeout')), this.options.readTimeoutMs ?? 15_000);
      cancel = addAbortListener(signal, () => resolve(error('cancelled')));
    });
    try { return await Promise.race([actual, abandoned]); }
    finally { clearTimeout(timeout); cancel?.[Symbol.dispose](); }
  }

  cancel(): Promise<void> {
    this.active?.abort.abort();
    return this.active?.worker?.then(() => {}, () => {}) ?? Promise.resolve();
  }
}

/** One fixed local worker per selection. Audio crosses stdin only and no environment credentials are inherited. */
export function runVoiceTranscription(executable: string, args: string[], audio: Buffer, signal: AbortSignal, timeoutMs = 90_000): Promise<VoiceDraftResult> {
  if (signal.aborted) return Promise.resolve(error('cancelled'));
  return new Promise(resolve => {
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'ignore'], env: {
      PATH: '/usr/bin:/bin', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1',
    } });
    let stopped: VoiceDraftError | undefined;
    const stop = (reason: VoiceDraftError) => {
      if (stopped) return;
      stopped = reason;
      child.kill('SIGKILL');
    };
    const cancel = addAbortListener(signal, () => stop('cancelled'));
    const timeout = setTimeout(() => stop('timeout'), timeoutMs);
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxOutput) stop('failed');
      else if (!stopped) chunks.push(chunk);
    });
    child.on('error', () => stop('failed'));
    child.stdin.on('error', () => stop('failed'));
    child.once('close', code => {
      clearTimeout(timeout);
      cancel[Symbol.dispose]();
      if (signal.aborted || stopped || code !== 0) return resolve(error(signal.aborted ? 'cancelled' : stopped ?? 'failed'));
      try {
        const output = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        if (!output.endsWith('\n') || output.indexOf('\n') !== output.length - 1) return resolve(error('failed'));
        const payload = JSON.parse(output);
        if (!payload || typeof payload !== 'object' || Object.keys(payload).length !== 1 || !Object.hasOwn(payload, 'text')) return resolve(error('failed'));
        if (payload.text === '') return resolve(error('no-speech'));
        return resolve(validVoiceDraft(payload.text) ? { ok: true, text: payload.text } : error('failed'));
      } catch { resolve(error('failed')); }
    });
    child.stdin.end(audio);
  });
}

/** Prevent ASR and the MLX TTS worker from holding both models at once. */
export class VoiceDraftSpeechGate {
  private lease?: symbol;
  constructor(private readonly suspend: () => Promise<boolean>, private readonly resume: (preload: boolean) => Promise<boolean>) {}

  get busy() { return this.lease !== undefined; }

  async acquire(): Promise<((preload: boolean) => Promise<boolean>) | undefined> {
    if (this.lease) return;
    const lease = this.lease = Symbol('voice-draft-speech');
    let acquired = false;
    try {
      if (!await this.suspend()) {
        await this.resume(false).catch(() => false);
        return;
      }
      acquired = true;
      let releaseResult: Promise<boolean> | undefined;
      return async preload => {
        if (releaseResult) return releaseResult;
        releaseResult = (async () => {
          try { return await this.resume(preload); }
          catch { return false; }
          finally { if (this.lease === lease) this.lease = undefined; }
        })();
        return releaseResult;
      };
    } catch {
      await this.resume(false).catch(() => false);
      return;
    } finally {
      if (!acquired && this.lease === lease) this.lease = undefined;
    }
  }
}
