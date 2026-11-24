import type { MicrophoneStart, VoiceDraftResult } from '../../../packages/contracts/src/voice-draft.ts';

export const micRate = 16_000, micMaxSamples = 30 * micRate, micHeader = 44;
const cancelled = { ok: false, error: 'cancelled' } as const;
const failed = { ok: false, error: 'failed' } as const;

export function makeMicWav(samples: Float32Array): ArrayBuffer | undefined {
  if (samples.length < micRate || samples.length > micMaxSamples) return;
  const bytes = new ArrayBuffer(micHeader + samples.length * 2), view = new DataView(bytes);
  const tag = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  tag(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, micRate, true); view.setUint32(28, 2 * micRate, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(micHeader + i * 2, value * (value < 0 ? 32768 : 32767), true);
  }
  return bytes;
}

export function validMicWav(value: unknown): value is ArrayBuffer {
  if (!(value instanceof ArrayBuffer) || value.byteLength < micHeader + 2 * micRate ||
      value.byteLength > micHeader + 2 * micMaxSamples || (value.byteLength - micHeader) % 2) return false;
  const v = new DataView(value);
  return v.getUint32(0) === 0x52494646 && v.getUint32(4, true) === value.byteLength - 8 &&
    v.getUint32(8) === 0x57415645 && v.getUint32(12) === 0x666d7420 && v.getUint32(16, true) === 16 &&
    v.getUint16(20, true) === 1 && v.getUint16(22, true) === 1 && v.getUint32(24, true) === micRate &&
    v.getUint32(28, true) === micRate * 2 && v.getUint16(32, true) === 2 && v.getUint16(34, true) === 16 &&
    v.getUint32(36) === 0x64617461 && v.getUint32(40, true) === value.byteLength - micHeader;
}

export type Recording = { cancel(): void; stop(): Promise<ArrayBuffer | undefined> };
type Ports = {
  arm(): Promise<{ ok: true; id: string } | Exclude<MicrophoneStart, { ok: true }>>;
  started(id: string): Promise<boolean>;
  cancel(id: string): Promise<void>;
  finish(id: string, audio: ArrayBuffer): Promise<VoiceDraftResult>;
};
type Capture = { abort: AbortController; id?: string; recording?: Recording; phase: 'opening' | 'recording' | 'finishing'; notify?: () => void };

export class MicrophoneCapture {
  private active?: Capture;
  private pendingOpens = 0;
  constructor(private readonly port: Ports, private readonly open: (signal: AbortSignal, deviceLost: () => void) => Promise<Recording>) {}
  async start(notify?: () => void): Promise<MicrophoneStart> {
    if (this.active || this.pendingOpens >= 2) return { ok: false, error: 'busy' };
    const capture: Capture = { phase: 'opening', abort: new AbortController(), notify };
    this.active = capture;
    try {
      const armed = await this.port.arm();
      if (!armed.ok) return armed;
      capture.id = armed.id;
      if (capture.abort.signal.aborted) return cancelled;
      const recording = await this.openUntilCancelled(capture);
      if (!recording || capture.abort.signal.aborted) { recording?.cancel(); return cancelled; }
      capture.recording = recording;
      if (!await this.port.started(armed.id) || capture.abort.signal.aborted) return cancelled;
      capture.phase = 'recording';
      return { ok: true };
    } catch { return capture.abort.signal.aborted ? cancelled : failed; }
    finally { if (capture.phase === 'opening') this.settle(capture); }
  }
  async stop(): Promise<VoiceDraftResult> {
    const capture = this.active;
    if (!capture || capture.phase === 'finishing' || capture.abort.signal.aborted) return cancelled;
    if (capture.phase === 'opening') { this.drop(capture); return cancelled; }
    capture.phase = 'finishing';
    try {
      const audio = await capture.recording!.stop();
      if (capture.abort.signal.aborted) return cancelled;
      if (!audio) return { ok: false, error: 'too-short' };
      const result = await this.port.finish(capture.id!, audio);
      return capture.abort.signal.aborted ? cancelled : result;
    } catch { return capture.abort.signal.aborted ? cancelled : failed; }
    finally { this.settle(capture); }
  }
  private async openUntilCancelled(capture: Capture): Promise<Recording | undefined> {
    const signal = capture.abort.signal;
    this.pendingOpens++;
    const opening = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return this.open(signal, () => this.interrupt(capture));
    }).then(recording => {
      if (signal.aborted) { recording.cancel(); return; }
      return recording;
    }).finally(() => { this.pendingOpens--; });
    let onAbort!: () => void;
    const abandoned = new Promise<undefined>(resolve => {
      onAbort = () => resolve(undefined);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try { return await Promise.race([opening, abandoned]); }
    finally { signal.removeEventListener('abort', onAbort); }
  }
  private settle(capture: Capture) {
    this.drop(capture);
    if (this.active === capture) this.active = undefined;
  }
  cancel() { if (this.active) this.drop(this.active); }
  revoked(id: unknown) { if (this.active?.id === id && this.active) this.interrupt(this.active); }
  private interrupt(capture: Capture) {
    if (this.active !== capture || capture.abort.signal.aborted) return;
    const notify = capture.notify;
    this.drop(capture);
    try { notify?.(); } catch { /* The renderer may already be gone. */ }
  }
  private drop(capture: Capture) {
    capture.abort.abort();
    capture.recording?.cancel();
    capture.recording = undefined;
    if (capture.id) { void this.port.cancel(capture.id).catch(() => {}); capture.id = undefined; }
    if (capture.phase === 'recording' && this.active === capture) this.active = undefined;
  }
}
