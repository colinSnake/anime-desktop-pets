import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, isAbsolute } from 'node:path';
import { parseTaskSnapshot, type TaskSnapshot } from './codex-task-lease.ts';

type Options = { home: string; worker: string; guardian: string; python?: string; timeoutMs?: number };
type Session = {
  child: ChildProcessWithoutNullStreams;
  serialBase: number;
  signal: AbortSignal;
  cancel(): void;
  exited: Promise<void>;
  buffer: Buffer;
  pending?: { resolve(snapshot: TaskSnapshot): void; reject(): void };
  stopping?: Promise<void>;
  done: boolean;
};
const unavailable = () => new Error('task_reader_unavailable');
const MAX_FRAME = 256;

/** A single supervised stdio reader. No output, error text or paths reach the workspace. */
export class CodexTaskReaderProcess {
  private session?: Session;
  private highestSerial = 0;
  constructor(private readonly options: Options) {}

  async sample(signal: AbortSignal): Promise<TaskSnapshot> {
    if (signal.aborted) throw unavailable();
    if (this.session && this.session.signal !== signal) await this.stop(this.session);
    if (signal.aborted || this.session?.stopping || this.session?.pending) throw unavailable();
    const session = this.session ?? this.start(signal);
    return new Promise<TaskSnapshot>((resolve, reject) => {
      const fail = () => {
        void this.stop(session).catch(() => {});
      };
      const timer = setTimeout(fail, this.options.timeoutMs ?? 1500);
      session.pending = {
        resolve: snapshot => { clearTimeout(timer); session.pending = undefined; resolve(snapshot); },
        reject: () => { clearTimeout(timer); session.pending = undefined; reject(unavailable()); },
      };
      session.child.stdin.write('poll\n', error => { if (error) fail(); });
    });
  }

  close(): Promise<void> {
    return this.session ? this.stop(this.session) : Promise.resolve();
  }

  private start(signal: AbortSignal): Session {
    const { home, worker, guardian, python } = this.options;
    const bootstrap = JSON.stringify({ home }) + '\n';
    if (!isAbsolute(home) || !isAbsolute(worker) || !isAbsolute(guardian) || Buffer.byteLength(bootstrap) > 4096) throw unavailable();
    const child = spawn(python || 'python3', ['-I', '-B', '-u', guardian, worker], {
      stdio: 'pipe', shell: false, windowsHide: true, cwd: dirname(worker),
      env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', LC_ALL: 'C' },
    });
    let exited!: () => void;
    const fail = () => { void this.stop(session).catch(() => {}); };
    const session: Session = { child, serialBase: this.highestSerial, signal, cancel: fail, done: false, buffer: Buffer.alloc(0), exited: new Promise(resolve => { exited = resolve; }) };
    this.session = session;
    signal.addEventListener('abort', fail, { once: true });
    child.stderr.resume();
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stdout.on('data', (chunk: Buffer) => {
      if (session.stopping) return;
      if (!session.pending || session.buffer.length + chunk.length > MAX_FRAME) { fail(); return; }
      session.buffer = Buffer.concat([session.buffer, chunk]);
      const newline = session.buffer.indexOf(10);
      if (newline === -1) return;
      if (newline !== session.buffer.length - 1) { fail(); return; }
      try {
        const snapshot = parseTaskSnapshot(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(session.buffer.subarray(0, newline))));
        if (!snapshot) { fail(); return; }
        session.buffer = Buffer.alloc(0);
        // Each fresh worker starts counting at one. Zero still means a cold or absent opening.
        if (snapshot.startSerial) {
          snapshot.startSerial += session.serialBase;
          if (!Number.isSafeInteger(snapshot.startSerial)) { fail(); return; }
          this.highestSerial = Math.max(this.highestSerial, snapshot.startSerial);
        }
        session.pending.resolve(snapshot);
      } catch { fail(); }
    });
    child.on('close', () => {
      signal.removeEventListener('abort', fail);
      session.done = true;
      session.pending?.reject();
      if (this.session === session) this.session = undefined;
      exited();
    });
    child.stdin.write(bootstrap, error => { if (error) fail(); });
    return session;
  }

  private stop(session: Session): Promise<void> {
    if (session.stopping) return session.stopping;
    session.signal.removeEventListener('abort', session.cancel);
    session.pending?.reject();
    // Guardian EOF first reaps its worker. Keep the slot if cleanup was not confirmed.
    session.stopping = (async () => {
      if (session.done) return;
      session.child.stdin.end();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([session.exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unavailable()), 3000); })]);
      } finally { clearTimeout(timer); }
    })();
    return session.stopping;
  }
}
