import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { SpeechBackend, SpeechTask } from './bubble-speech.ts';

type SpeechRuntimeConfig = { python: string; model: string; worker: string };
export function isSpeechRuntimeConfig(value: unknown): value is SpeechRuntimeConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3) return false;
  const object = value as Record<string, unknown>;
  return ['python', 'model', 'worker'].every(key => typeof object[key] === 'string' && object[key].length <= 1024 && !object[key].includes('\0') && isAbsolute(object[key]));
}

type Pending = { send(): void; reject(): void; audioStarted(): void; finish(): void };
type Session = {
  child: ChildProcessWithoutNullStreams; path: string; buffer: Buffer; exited: Promise<void>;
  ready: boolean; done: boolean; pending?: Pending; stopping?: Promise<void>; idle?: ReturnType<typeof setTimeout>;
};
const failure = () => new Error('speech_runtime_unavailable');

/** Owns one private TTS worker; retained briefly between cues to reuse the model and output stream. */
export class LocalBubbleSpeechBackend implements SpeechBackend {
  private session?: Session;
  private opening?: Promise<Session>;
  constructor(private config: SpeechRuntimeConfig & { guardian: string }, private timeoutMs = 180_000) {}

  async run(task: SpeechTask): Promise<void> {
    if (task.signal.aborted) throw failure();
    if (this.session?.stopping) await this.session.stopping;
    if (!this.session) {
      this.opening = this.open(task);
      try { await this.opening; } finally { this.opening = undefined; }
    }
    const session = this.session;
    if (!session) throw failure();
    clearTimeout(session.idle);
    try {
      if (session.done || session.stopping || task.signal.aborted) throw failure();
      await new Promise<void>((resolve, reject) => {
        let sent = false, started = false, settled = false;
        const settle = (ok: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer); task.signal.removeEventListener('abort', aborted);
          session.pending = undefined;
          if (ok) resolve(); else reject(failure());
        };
        const aborted = () => settle(false);
        const timer = setTimeout(aborted, this.timeoutMs);
        task.signal.addEventListener('abort', aborted, { once: true });
        session.pending = {
          send: () => {
            if (sent || task.signal.aborted) { settle(false); return; }
            sent = true;
            session.child.stdin.write(JSON.stringify({ type: 'respond', text: task.text, speak: true }) + '\n', error => { if (error) settle(false); });
          },
          audioStarted: () => { if (!sent || started) { settle(false); return; } started = true; task.resolveStatus('speaking'); },
          finish: () => settle(sent && started),
          reject: aborted,
        };
        if (session.ready) session.pending.send();
      });
      if (!session.stopping && !task.signal.aborted) {
        session.idle = setTimeout(() => { void this.stop(session).catch(() => {}); }, 90_000);
        session.idle.unref();
      }
    } catch {
      await this.stop(session);
      throw failure();
    }
  }

  async close(): Promise<void> {
    await this.opening?.catch(() => {});
    if (this.session) await this.stop(this.session);
  }

  private async open(task: SpeechTask): Promise<Session> {
    const path = await mkdtemp(join(await realpath(tmpdir()), 'anime-pet-speech-'));
    try {
      const model = await lstat(this.config.model);
      if (!model.isDirectory() || model.isSymbolicLink()) throw failure();
      await writeFile(join(path, 'reference.wav'), task.audio, { mode: 0o600, flag: 'wx' });
      await writeFile(join(path, 'reference.txt'), task.transcript, { mode: 0o600, flag: 'wx' });
      if (task.signal.aborted) throw failure();
      const startup = JSON.stringify({ directory: path, model: this.config.model }) + '\n';
      if (Buffer.byteLength(startup) > 4096) throw failure();
      const child = spawn(this.config.python, ['-I', '-B', '-u', this.config.guardian, this.config.worker], {
        stdio: 'pipe', shell: false, windowsHide: true, cwd: path,
        env: { HOME: path, XDG_CACHE_HOME: path, PATH: '/usr/bin:/bin', LC_ALL: 'en_US.UTF-8', HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1' },
      });
      let exited!: () => void;
      const session: Session = { child, path, buffer: Buffer.alloc(0), exited: new Promise(resolve => { exited = resolve; }), ready: false, done: false };
      this.session = session;
      const fail = () => { session.pending?.reject(); void this.stop(session).catch(() => {}); };
      child.stderr.resume();
      child.on('error', fail);
      child.stdin.on('error', fail);
      child.stdout.on('data', (chunk: Buffer) => this.receive(session, chunk, fail));
      child.on('close', () => { session.done = true; exited(); fail(); });
      child.stdin.write(startup, error => { if (error) fail(); });
      return session;
    } catch {
      await rm(path, { recursive: true, force: true }).catch(() => {});
      throw failure();
    }
  }

  private receive(session: Session, chunk: Buffer, fail: () => void) {
    if (session.stopping) return;
    if (session.buffer.length + chunk.length > 4096) { fail(); return; }
    session.buffer = Buffer.concat([session.buffer, chunk]);
    let newline: number;
    while ((newline = session.buffer.indexOf(10)) >= 0) {
      const line = session.buffer.subarray(0, newline).toString('utf8');
      session.buffer = session.buffer.subarray(newline + 1);
      if (line === 'ready' && !session.ready) { session.ready = true; session.pending?.send(); }
      else if (line === 'audio-started' && session.ready && session.pending) session.pending.audioStarted();
      else if (line === 'idle' && session.ready && session.pending) session.pending.finish();
      else { fail(); return; }
    }
  }

  private stop(session: Session): Promise<void> {
    if (session.stopping) return session.stopping;
    clearTimeout(session.idle); session.pending?.reject();
    session.stopping = (async () => {
      if (!session.done) {
        session.child.stdin.end();
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([session.exited, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(failure()), 3000); })]);
        } finally { clearTimeout(deadline); }
      }
      await rm(session.path, { recursive: true, force: true });
      if (this.session === session) this.session = undefined;
    })();
    const stop = session.stopping;
    void stop.catch(() => { if (session.stopping === stop) session.stopping = undefined; });
    return stop;
  }
}
