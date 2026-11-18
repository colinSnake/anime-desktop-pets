import { shape } from '../../../packages/contracts/src/pets.ts';

export type TaskPresence = 'running' | 'not-detected' | 'unknown';
export type TaskSnapshot = { state: 'working' | 'idle' | 'unknown'; activeCount: number; startSerial: number };
const UNKNOWN: TaskSnapshot = { state: 'unknown', activeCount: 0, startSerial: 0 };
const LEASE_MS = 10_000;
const MAX_ACTIVE_TURNS = 64 * 64; // Existing reader: 64 selected files, at most 64 turns per file.

type Timer = (callback: () => void, ms: number) => () => void;
type Ports = { canFollow(): boolean; now?: () => number; schedule?: Timer };
type Grant = { controller: AbortController; expiresAt: number };

const timer: Timer = (callback, ms) => {
  const handle = setTimeout(callback, Math.ceil(ms));
  handle.unref();
  return () => clearTimeout(handle);
};

// Return promptly on revocation even if an adapter takes longer to unwind.
// The caller still owns the in-flight slot until the producer settles.
async function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return;
  let abort!: () => void;
  const cancelled = new Promise<undefined>(resolve => {
    abort = () => resolve(undefined);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

export function parseTaskSnapshot(value: unknown): TaskSnapshot | undefined {
  if (shape(value, ['state', 'activeCount', 'startSerial'])) {
    const { state, activeCount, startSerial } = value;
    if (state === 'working' && typeof activeCount === 'number' && Number.isSafeInteger(activeCount) &&
        activeCount >= 1 && activeCount <= MAX_ACTIVE_TURNS && typeof startSerial === 'number' &&
        Number.isSafeInteger(startSerial) && startSerial >= 0) return { state, activeCount, startSerial };
    if ((state === 'idle' || state === 'unknown') && activeCount === 0 && startSerial === 0) return { state, activeCount, startSerial };
  }
}

/** Service-internal authority. Nothing is persisted or exposed via IPC or HTTP. */
export class CodexTaskLease {
  private optIn?: AbortController;
  private grant?: Grant;
  private cancelExpiry?: () => void;
  private probing = false;
  private reading = false;
  private readonly now: () => number;
  private readonly schedule: Timer;

  constructor(private readonly ports: Ports) {
    this.now = ports.now ?? (() => performance.now());
    this.schedule = ports.schedule ?? timer;
  }

  enable(): boolean {
    if (!this.ports.canFollow()) { this.disable(); return false; }
    this.optIn ??= new AbortController();
    return true;
  }

  disable(): void {
    const previous = this.optIn;
    this.optIn = undefined;
    this.revokeGrant();
    previous?.abort();
  }

  /** Only an explicitly armed, current session can use a trusted presence check. */
  async refresh(probe: (signal: AbortSignal) => Promise<TaskPresence>): Promise<boolean> {
    const optIn = this.session();
    if (!optIn || this.probing) return false;
    this.probing = true;
    const expiresAt = this.now() + LEASE_MS;
    const operation = (async () => {
      try { return await probe(optIn.signal); }
      catch { return 'unknown'; }
      finally { this.probing = false; }
    })();
    const presence = await untilAborted(operation, optIn.signal);
    if (this.session() !== optIn) return false;
    const existing = this.liveGrant();
    if (this.optIn !== optIn) return false;
    if (presence !== 'running' || this.now() >= expiresAt) { this.revokeGrant(); return false; }
    const grant = this.grant = existing ?? { controller: new AbortController(), expiresAt };
    grant.expiresAt = expiresAt;
    this.cancelExpiry?.();
    this.scheduleExpiry(grant, expiresAt);
    return true;
  }

  /** Undefined means no admitted sample; read errors under a live grant mean unknown, never idle. */
  async sample(read: (signal: AbortSignal) => Promise<unknown>): Promise<TaskSnapshot | undefined> {
    const grant = this.liveGrant();
    if (!grant || this.reading) return;
    this.reading = true;
    const signal = grant.controller.signal;
    const operation = (async () => {
      try { return parseTaskSnapshot(await read(signal)) ?? { ...UNKNOWN }; }
      catch { return { ...UNKNOWN }; }
      finally { this.reading = false; }
    })();
    const result = await untilAborted(operation, signal);
    if (this.liveGrant() === grant) return result;
  }

  private session(): AbortController | undefined {
    if (!this.ports.canFollow()) this.disable();
    return this.optIn;
  }

  private liveGrant(): Grant | undefined {
    if (!this.session()) return;
    if (this.grant && this.now() >= this.grant.expiresAt) { this.revokeGrant(); return; }
    return this.grant;
  }

  private scheduleExpiry(grant: Grant, expiresAt: number): void {
    this.cancelExpiry = this.schedule(() => {
      if (this.grant !== grant || grant.expiresAt !== expiresAt) return;
      if (this.liveGrant() === grant) this.scheduleExpiry(grant, expiresAt);
    }, Math.max(0, expiresAt - this.now()));
  }

  private revokeGrant(): void {
    const previous = this.grant;
    this.grant = undefined;
    this.cancelExpiry?.();
    this.cancelExpiry = undefined;
    previous?.controller.abort();
  }
}
