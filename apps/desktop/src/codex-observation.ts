import type { CodexPresence } from './codex-presence.ts';

export type CodexObservationState = 'off' | 'checking' | CodexPresence;
type Ports = {
  read(): Promise<CodexPresence>;
  changed(state: CodexObservationState): void;
  schedule?(callback: () => void, delay: number): () => void;
};
const interval = 10_000;
function schedule(callback: () => void, delay: number): () => void {
  const timer = setTimeout(callback, delay);
  timer.unref();
  return () => clearTimeout(timer);
}

/** Session opt-in; serialize even across an off/on cycle. Only the menu consumes samples. */
export class CodexObservation {
  private current: CodexObservationState = 'off';
  private generation = 0;
  private closed = false;
  private pending?: Promise<void>;
  private cancelTimer?: () => void;

  constructor(private readonly ports: Ports) {}
  get state(): CodexObservationState { return this.current; }

  setEnabled(enabled: boolean): void {
    if (this.closed || enabled === (this.current !== 'off')) return;
    this.invalidate();
    this.publish(enabled ? 'checking' : 'off');
    if (enabled) this.poll();
  }

  dispose(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.invalidate();
      this.current = 'off';
    }
    // The fixed native probe has a short deadline. Wait for our own child, never for Codex.
    return this.pending ?? Promise.resolve();
  }

  private invalidate(): void {
    this.generation++;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  private publish(state: CodexObservationState): void {
    if (this.current === state) return;
    this.current = state;
    this.ports.changed(state);
  }

  private poll(): void {
    if (this.closed || this.current === 'off' || this.pending) return;
    const generation = this.generation;
    this.pending = Promise.resolve().then(async () => {
      if (this.generation !== generation) return;
      let state: CodexPresence = 'unknown';
      try { state = await this.ports.read(); } catch { /* Clear the previous sample. */ }
      if (this.generation === generation) this.publish(state);
    }).finally(() => {
      this.pending = undefined;
      if (this.closed || this.current === 'off') return;
      if (this.generation !== generation) {
        this.poll();
        return;
      }
      this.cancelTimer = (this.ports.schedule ?? schedule)(() => {
        if (this.generation !== generation) return;
        this.cancelTimer = undefined;
        this.poll();
      }, interval);
    });
  }
}
