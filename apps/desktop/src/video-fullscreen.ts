import { execFile, type ExecFileOptionsWithBufferEncoding } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
type Execute = (file: string, args: string[], options: ExecFileOptionsWithBufferEncoding) => Promise<{ stdout: Buffer; stderr: Buffer }>;
export async function readVideoFullscreen(bundle: string, signal: AbortSignal, run: Execute = execute): Promise<boolean | undefined> {
  if (signal.aborted) return;
  try {
    const { stdout, stderr } = await run(join(bundle, 'video-fullscreen'), [], {
      encoding: 'buffer', env: { LC_ALL: 'C' }, shell: false, timeout: 750, maxBuffer: 16, killSignal: 'SIGKILL', signal,
    });
    if (signal.aborted || stderr.length) return;
    const bit = stdout.toString('utf8');
    return bit === 'v1 1\n' ? true : bit === 'v1 0\n' ? false : undefined;
  } catch { /* Unknown result: do not undo a confirmed automatic hide. */ }
}

const every = (tick: () => void) => { const timer = setInterval(tick, 750); return () => clearInterval(timer); };
/** Only one bounded query for all live windows; uncertain samples cannot cause flicker. */
export class VideoFullscreenObserver {
  private readonly listeners = new Set<(value: boolean) => void>();
  private polling?: () => void;
  private query?: AbortController;
  private value?: boolean;
  private candidate?: boolean;
  constructor(private readonly read: (signal: AbortSignal) => Promise<boolean | undefined>, private readonly schedule = every) {}

  subscribe(listener: (value: boolean) => void) {
    this.listeners.add(listener);
    if (this.value !== undefined) listener(this.value);
    if (!this.polling) {
      this.polling = this.schedule(() => void this.poll());
      void this.poll();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      this.polling?.(); this.polling = undefined;
      this.query?.abort(); this.query = undefined;
      this.value = this.candidate = undefined;
    };
  }

  private async poll() {
    if (this.query || !this.listeners.size) return;
    const own = this.query = new AbortController();
    const result = await this.read(own.signal).catch(() => undefined);
    if (this.query !== own || own.signal.aborted) return;
    this.query = undefined;
    if (this.value !== undefined && (result === undefined || result === this.value || result !== this.candidate)) {
      this.candidate = result;
      return;
    }
    // A missing first signal allows normal play. Later missing signals retain known state.
    this.value = result ?? false;
    this.candidate = undefined;
    for (const listener of this.listeners) listener(this.value);
  }
}
