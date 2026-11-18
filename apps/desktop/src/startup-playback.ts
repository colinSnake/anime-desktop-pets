import type { StartupPlayback } from './startup-launch.ts';

export const STARTUP_SCHEME = 'pet-startup';
export const STARTUP_ORIGIN = `${STARTUP_SCHEME}://player`;
export const STARTUP_URL = `${STARTUP_ORIGIN}/index.html`;
export type PlaybackSignal = 'playing' | 'finished' | 'skipped' | 'failed';

export function startupSignal(url: string, mainFrame: boolean): PlaybackSignal | undefined {
  if (!mainFrame) return;
  for (const signal of ['playing', 'finished', 'skipped', 'failed'] as const) {
    if (url === `${STARTUP_URL}#${signal}`) return signal;
  }
}

type Ports = {
  show(): void;
  close(): void;
  startAlignment?(): () => void;
  schedule?: typeof scheduleStartupTimer;
};
export function scheduleStartupTimer(ms: number, callback: () => void): () => void {
  const handle = setTimeout(callback, ms);
  handle.unref();
  return () => clearTimeout(handle);
}

export function manageStartupPlayback(ports: Ports): StartupPlayback & { signal(signal: PlaybackSignal): void } {
  const schedule = ports.schedule ?? scheduleStartupTimer;
  let closed = false, shown = false;
  let stopAlignment: (() => void) | undefined;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const close = () => {
    if (closed) return;
    closed = true;
    cancelLoad(); cancelPlayback();
    stopAlignment?.();
    try { ports.close(); } catch { /* The native window might already have been destroyed. */ }
    finish();
  };
  const cancelLoad = schedule(8000, close);
  const cancelPlayback = schedule(30_000, close);
  return { done, close, signal(signal) {
    if (closed) return;
    if (signal !== 'playing') { close(); return; }
    if (shown) return;
    shown = true;
    cancelLoad();
    try { ports.show(); } catch { close(); return; }
    if (closed) return;
    try { stopAlignment = ports.startAlignment?.(); } catch { /* Keep playing without alignment. */ }
  } };
}
