import { randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import { opendir, rename, type FileHandle } from 'node:fs/promises';
import { shape } from '../../../../packages/contracts/src/pets.ts';
import { PrivateDirectory, sameFile } from './private-directory.ts';

const CAP = 12, LIMIT = 32_768;
const FILE = 'model-acceptance-budget.json', GUARD = '.model-acceptance.guard', LOCK = '.model-acceptance-writer.lock';
const purposes = ['memory.batch', 'expression.reply', 'speech.roundtrip', 'bubble.synthetic'] as const;
export type AcceptancePurpose = typeof purposes[number];
type Reservation = { attempt: number; purpose: AcceptancePurpose };
type Guard = { version: 1; runID: string; fingerprint: string };
type State = { version: 1; runID: string; maximumAttempts: typeof CAP; reservations: Reservation[] };
type Snapshot = Pick<State, 'version' | 'maximumAttempts' | 'reservations'> & { remaining: number };
type DiskFile = NonNullable<Awaited<ReturnType<PrivateDirectory['read']>>>;
type ErrorCode = 'approval_required' | 'invalid_purpose' | 'invalid_route' | 'route_changed' | 'not_initialized' | 'ledger_exists' |
  'corrupt_ledger' | 'exhausted' | 'busy' | 'storage_unavailable' | 'publication_uncertain';
type StorageIO = { rename?: typeof rename; syncPublication?: () => Promise<void> };

class AcceptanceLedgerError extends Error {
  constructor(readonly code: ErrorCode) { super(code); this.name = 'AcceptanceLedgerError'; }
}
const fail = (code: ErrorCode): never => { throw new AcceptanceLedgerError(code); };
const validPurpose = (value: unknown): value is AcceptancePurpose => purposes.some(purpose => purpose === value);
const hex = (value: unknown, length: number): value is string => typeof value === 'string' && value.length === length && /^[a-f0-9]+$/.test(value);
const snapshot = ({ version, maximumAttempts, reservations }: State): Snapshot => ({ version, maximumAttempts, reservations, remaining: maximumAttempts - reservations.length });
const encode = (value: Guard | State) => Buffer.from(`${JSON.stringify(value)}\n`);
function decode(file: DiskFile): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)); }
  catch { return fail('corrupt_ledger'); }
}

/** Internal lifetime budget for one explicitly approved synthetic run. The caller
 * owns an unused private directory and supplies a single trusted transport call.
 * No normal service path opens this budget; it must never replace a legacy run. */
export class ModelAcceptanceLedger {
  private readonly directory: PrivateDirectory;
  private queue: Promise<unknown> = Promise.resolve();
  private observed = false;
  private uncertain = false;

  constructor(root: string, private readonly io: StorageIO = {}) {
    try { this.directory = new PrivateDirectory(root, false); }
    catch { throw new AcceptanceLedgerError('storage_unavailable'); }
  }

  async initialize(approvedMaximumAttempts: unknown, fingerprint: string): Promise<Snapshot> {
    if (approvedMaximumAttempts !== CAP) fail('approval_required');
    if (!hex(fingerprint, 64)) fail('invalid_route');
    return this.locked(async lock => {
      if (await this.load()) fail('ledger_exists');
      // Only a newly designated run directory may be initialized. In particular,
      // never initialize next to a previous/foreign ledger or an incomplete write.
      for await (const entry of await opendir(this.directory.root)) {
        if (entry.name !== LOCK) fail('ledger_exists');
      }
      const guard: Guard = { version: 1, runID: randomBytes(16).toString('hex'), fingerprint };
      const state: State = { version: 1, runID: guard.runID, maximumAttempts: CAP, reservations: [] };
      const guardHandle = await this.directory.create(GUARD);
      this.observed = true;
      try { await guardHandle.writeFile(encode(guard)); await guardHandle.sync(); }
      finally { await guardHandle.close(); }
      await this.directory.sync();
      const file = await this.read(GUARD);
      if (!file || !file.bytes.equals(encode(guard))) return fail('storage_unavailable');
      await this.publish(state, lock, file);
      return snapshot(state);
    });
  }

  snapshot(): Promise<Snapshot> {
    return this.locked(async () => snapshot((await this.load() ?? fail('not_initialized')).state));
  }

  async withReservation<T>(purpose: AcceptancePurpose, fingerprint: string, operation: () => Promise<T>): Promise<T> {
    if (!validPurpose(purpose)) fail('invalid_purpose');
    if (!hex(fingerprint, 64)) fail('invalid_route');
    await this.locked(async lock => {
      if (this.uncertain) fail('publication_uncertain');
      const { guard, state, guardFile, stateFile } = await this.load() ?? fail('not_initialized');
      if (guard.fingerprint !== fingerprint) fail('route_changed');
      const attempt = state.reservations.length + 1;
      if (attempt > CAP) fail('exhausted');
      await this.publish({ ...state, reservations: [...state.reservations, { attempt, purpose }] }, lock, guardFile, stateFile);
    });
    // Network/fixture failure (including cancellation) never refunds this debit.
    return operation();
  }

  private read(name: string) { return this.directory.read(name, LIMIT, () => { this.observed = true; }); }

  private async load(): Promise<{ guard: Guard; state: State; guardFile: DiskFile; stateFile: DiskFile } | undefined> {
    const guardFile = await this.read(GUARD), stateFile = await this.read(FILE);
    if (!guardFile && !stateFile && !this.observed) return undefined;
    if (!guardFile || !stateFile) return fail('corrupt_ledger');
    const guard = decode(guardFile), state = decode(stateFile);
    if (!shape(guard, ['version', 'runID', 'fingerprint']) || guard.version !== 1 || !hex(guard.runID, 32) || !hex(guard.fingerprint, 64) ||
        !shape(state, ['version', 'runID', 'maximumAttempts', 'reservations']) || state.version !== 1 || state.runID !== guard.runID ||
        state.maximumAttempts !== CAP || !Array.isArray(state.reservations) || state.reservations.length > CAP ||
        !state.reservations.every((row, i) => shape(row, ['attempt', 'purpose']) && row.attempt === i + 1 && validPurpose(row.purpose))) return fail('corrupt_ledger');
    return { guard: { version: 1, runID: guard.runID, fingerprint: guard.fingerprint },
      state: { version: 1, runID: guard.runID, maximumAttempts: CAP, reservations: state.reservations }, guardFile, stateFile };
  }

  private locked<T>(operation: (lock: Stats) => Promise<T>): Promise<T> {
    const pending = this.queue.then(async () => {
      let handle: FileHandle | undefined, lock: Stats | undefined;
      try {
        try { handle = await this.directory.create(LOCK); }
        catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') fail('busy');
          throw error;
        }
        lock = await handle.stat();
        return await operation(lock);
      } catch (error) {
        if (error instanceof AcceptanceLedgerError) throw error;
        return fail('storage_unavailable');
      } finally {
        try { await handle?.close(); if (lock) await this.directory.removeOwned(LOCK, lock); }
        catch { fail('storage_unavailable'); }
      }
    });
    this.queue = pending.catch(() => {});
    return pending;
  }

  private async publish(state: State, lock: Stats, guard: DiskFile, previous?: DiskFile): Promise<void> {
    const name = `.model-acceptance-${randomBytes(16).toString('hex')}.tmp`, bytes = encode(state);
    const handle = await this.directory.create(name);
    let identity: Stats | undefined;
    let renamed = false;
    const matches = (before: DiskFile | undefined, after: DiskFile | undefined) => before ? !!after && sameFile(before.info, after.info) && before.bytes.equals(after.bytes) : !after;
    try {
      try { identity = await handle.stat(); await handle.writeFile(bytes); await handle.sync(); }
      finally { await handle.close(); }
      const prepared = await this.directory.read(name, LIMIT), owned = await this.directory.read(LOCK, 0);
      if (!prepared || !sameFile(prepared.info, identity) || !prepared.bytes.equals(bytes) || !owned || !sameFile(owned.info, lock) ||
          !matches(guard, await this.read(GUARD)) || !matches(previous, await this.read(FILE))) fail('storage_unavailable');
      try {
        await (this.io.rename ?? rename)(this.directory.path(name), this.directory.path(FILE));
        renamed = true;
        await (this.io.syncPublication ? this.io.syncPublication() : this.directory.sync());
      } catch {
        // Rename can have taken effect even when the caller observes an error.
        // Preserve whatever is published and never authorize outbound on doubt.
        this.uncertain = true;
        fail('publication_uncertain');
      }
    } finally {
      if (!renamed && identity) await this.directory.removeOwned(name, identity).catch(() => {});
    }
  }
}
