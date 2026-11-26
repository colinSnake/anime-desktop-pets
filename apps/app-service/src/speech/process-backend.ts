import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { lstat, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isLiveDanmakuReply, liveActionIds } from '../../../../packages/contracts/src/live-stage.ts';
import { stageVoiceDuration, type LiveVoiceBank, liveVoiceClipLimit } from '../../../../packages/contracts/src/live-voice.ts';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { SpeechRuntimeReadiness } from '../../../../packages/contracts/src/speech.ts';
import type { SpeechBackend, SpeechProfileInput, SpeechTask } from './bubble-speech.ts';

type SpeechRuntimeConfig = { python: string; model: string; worker: string };
export function isSpeechRuntimeConfig(value: unknown): value is SpeechRuntimeConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3) return false;
  const object = value as Record<string, unknown>;
  return ['python', 'model', 'worker'].every(key => typeof object[key] === 'string' && object[key].length <= 1024 && !object[key].includes('\0') && isAbsolute(object[key]));
}

type Pending = { send(): void; reject(): void; audioStarted(): void; finish(): void; stageReady?(): void };
type Session = {
  child: ChildProcessWithoutNullStreams; path: string; buffer: Buffer; exited: Promise<void>;
  profile: SpeechProfileInput; ready: boolean; done: boolean; retiring?: boolean; pending?: Pending; stopping?: Promise<void>;
  startup?: ReturnType<typeof setTimeout>; idle?: ReturnType<typeof setTimeout>;
};
const failure = () => new Error('speech_runtime_unavailable');

/** Owns one private TTS worker; retained briefly between cues to reuse the model and output stream. */
export class LocalBubbleSpeechBackend implements SpeechBackend {
  private session?: Session;
  private opening?: Promise<Session>;
  private runtimeFailed = false;
  constructor(private config: SpeechRuntimeConfig & { guardian: string }, private timeoutMs = 180_000) {}

  prepare(profile: SpeechProfileInput): void {
    // Start loading only after the session is explicitly enabled. Opening the
    // worker never sends synthesis instructions or opens an output device.
    if (!this.session) void this.ensureSession(profile).catch(() => {});
  }

  readiness(): SpeechRuntimeReadiness {
    if (this.runtimeFailed) return 'failed';
    if (this.session) return this.session.retiring || this.session.done ? 'cold' : this.session.ready ? 'ready' : 'preparing';
    return this.opening ? 'preparing' : 'cold';
  }

  private ensureSession(profile: SpeechProfileInput) {
    if (this.opening) return this.opening;
    if (this.session) return Promise.resolve(this.session);
    this.runtimeFailed = false;
    return this.opening = this.open(profile).catch(error => {
      this.runtimeFailed = true;
      throw error;
    }).finally(() => { this.opening = undefined; });
  }

  private async sessionFor(profile: SpeechProfileInput) {
    if (this.opening) await this.opening;
    const old = this.session;
    if (old && (old.retiring || old.profile.transcript !== profile.transcript || (old.profile.audio !== profile.audio && !old.profile.audio.equals(profile.audio)))) await this.stop(old);
    return this.ensureSession(profile);
  }

  async renderStage(profile: SpeechProfileInput, signal: AbortSignal): Promise<LiveVoiceBank> {
    return this.captureStage(profile,signal,{type:'capture-stage'},liveActionIds);
  }

  async renderStageReply(profile: SpeechProfileInput, text: string, signal: AbortSignal): Promise<Buffer> {
    if (!isLiveDanmakuReply(text)) throw failure();
    return (await this.captureStage(profile,signal,{type:'capture-stage-reply',text},['reply'])).reply;
  }

  private async captureStage<K extends string>(profile: SpeechProfileInput, signal: AbortSignal, command: object, ids: readonly K[]): Promise<Record<K,Buffer>> {
    if (signal.aborted) throw failure();
    const session = await this.sessionFor(profile);
    clearTimeout(session.idle);
    try {
      if (session.done || session.stopping || session.pending || signal.aborted) throw failure();
      await new Promise<void>((resolve, reject) => {
        let sent = false, settled = false;
        const settle = (ok: boolean) => {
          if (settled) return;
          settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
          session.pending = undefined;
          if (ok) resolve(); else reject(failure());
        };
        const abort = () => settle(false);
        const timer = setTimeout(abort, Math.min(60_000, this.timeoutMs));
        signal.addEventListener('abort', abort, {once:true});
        session.pending = {
          send: () => {
            if (sent || signal.aborted) { abort(); return; }
            sent = true;
            session.child.stdin.write(`${JSON.stringify(command)}\n`, error => { if (error) abort(); });
          },
          audioStarted: abort, finish: abort, reject: abort, stageReady: () => settle(sent),
        };
        if (session.ready) session.pending.send();
      });
      const clips = {} as Record<K,Buffer>;
      for (const id of ids) {
        if (signal.aborted) throw failure();
        const name = join(session.path, `stage-${id}.wav`);
        const file = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > liveVoiceClipLimit) throw failure();
          const bytes = Buffer.alloc(stat.size + 1);
          const {bytesRead} = await file.read(bytes, 0, bytes.length, 0);
          const wav = bytes.subarray(0, bytesRead);
          if (bytesRead !== stat.size || !stageVoiceDuration(wav)) throw failure();
          clips[id] = wav;
        } finally { await file.close(); }
        await rm(name);
      }
      if (signal.aborted || session.stopping || session.done) throw failure();
      this.expireWhenIdle(session);
      return clips;
    } catch {
      await this.stop(session);
      throw failure();
    }
  }

  private expireWhenIdle(session: Session) {
    session.idle = setTimeout(() => { void this.stop(session).catch(() => {}); }, 90_000);
    session.idle.unref();
  }

  async run(task: SpeechTask): Promise<void> {
    if (task.signal.aborted) throw failure();
    if (this.session?.stopping) await this.session.stopping;
    if (task.signal.aborted) throw failure();
    const session = await this.sessionFor(task);
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
      if (!session.stopping && !task.signal.aborted) this.expireWhenIdle(session);
    } catch {
      await this.stop(session);
      throw failure();
    }
  }

  async close(): Promise<void> {
    await this.opening?.catch(() => {});
    if (this.session) await this.stop(this.session);
    this.runtimeFailed = false;
  }

  private async open(profile: SpeechProfileInput): Promise<Session> {
    const path = await mkdtemp(join(await realpath(tmpdir()), 'anime-pet-speech-'));
    try {
      const model = await lstat(this.config.model);
      if (!model.isDirectory() || model.isSymbolicLink()) throw failure();
      await writeFile(join(path, 'reference.wav'), profile.audio, { mode: 0o600, flag: 'wx' });
      await writeFile(join(path, 'reference.txt'), profile.transcript, { mode: 0o600, flag: 'wx' });
      const startup = JSON.stringify({ directory: path, model: this.config.model }) + '\n';
      if (Buffer.byteLength(startup) > 4096) throw failure();
      const child = spawn(this.config.python, ['-I', '-B', '-u', this.config.guardian, this.config.worker], {
        stdio: 'pipe', shell: false, windowsHide: true, cwd: path,
        env: { HOME: path, XDG_CACHE_HOME: path, PATH: '/usr/bin:/bin', LC_ALL: 'en_US.UTF-8', HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1' },
      });
      let exited!: () => void;
      const session: Session = { child, path, profile: {audio:profile.audio, transcript:profile.transcript}, buffer: Buffer.alloc(0), exited: new Promise(resolve => { exited = resolve; }), ready: false, done: false };
      this.session = session;
      const fail = () => {
        if (this.session === session && !session.stopping) this.runtimeFailed = true;
        session.pending?.reject();
        void this.stop(session).catch(() => {});
      };
      child.stderr.resume();
      child.on('error', fail);
      child.stdin.on('error', fail);
      child.stdout.on('data', (chunk: Buffer) => this.receive(session, chunk, fail));
      child.on('close', () => { session.done = true; exited(); fail(); });
      // Model preload must report ready without synthesizing or opening the output device.
      session.startup = setTimeout(fail, Math.min(30_000, this.timeoutMs));
      session.startup.unref();
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
      if (line === 'ready' && !session.ready) {
        clearTimeout(session.startup);
        session.ready = true;
        if (session.pending) session.pending.send();
        else this.expireWhenIdle(session);
      }
      else if (line === 'audio-started' && session.ready && session.pending) session.pending.audioStarted();
      else if (line === 'stage-ready' && session.ready && session.pending?.stageReady) session.pending.stageReady();
      else if (line === 'idle' && session.ready && session.pending) session.pending.finish();
      else { fail(); return; }
    }
  }

  private stop(session: Session): Promise<void> {
    if (session.stopping) return session.stopping;
    session.retiring = true;
    clearTimeout(session.startup); clearTimeout(session.idle); session.pending?.reject();
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
