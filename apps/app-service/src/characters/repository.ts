import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { rename, type FileHandle } from 'node:fs/promises';
import { petId, revision } from '../../../../packages/contracts/src/pets.ts';
import { PrivateDirectory, sameFile } from '../models/private-directory.ts';
import { CHARACTER_LIMIT, CharacterError, invalid, isCommand, isState, type CharacterState, type Command } from './records.ts';
import { transition } from './operations.ts';

const storage = () => new CharacterError('character_storage_unavailable');
const encoder = (state: CharacterState) => Buffer.from(JSON.stringify(state) + '\n');
const decoder = new TextDecoder('utf-8', { fatal: true });
const empty = (petID: string): CharacterState => ({ schemaVersion: 1, petID, revision: 0, identity: null, identityHistory: [], memories: [], goals: [] });
type OwnedLock = { handle: FileHandle; info: Stats };
type Source = Awaited<ReturnType<PrivateDirectory['read']>>;
type Options = { clock?: () => Date; io?: { rename?: typeof rename; syncDirectory?: () => Promise<void> } };
type Publication = { state: CharacterState; durability: 'confirmed' | 'unconfirmed' | 'unchanged' };
const unchanged = (a: Source, b: Source) => a ? !!b && sameFile(a.info, b.info) && a.bytes.equals(b.bytes) : b === undefined;

/** Internal persistence for trusted new-profile instance IDs. Instance ownership
 * is checked by the workspace service adapter; no paths or generic writes cross it. */
export class CharacterRepository {
  private readonly directory: PrivateDirectory;
  private readonly observed = new Set<string>();
  private readonly uncertain = new Set<string>();
  private readonly onlineUnconfirmed = new Set<string>();
  private readonly pendingLocks = new Map<string, OwnedLock>();
  private queue: Promise<unknown> = Promise.resolve();
  private acceptingWrites = true;
  private closing?: Promise<void>;

  constructor(root: string, private readonly options: Options = {}) {
    try { this.directory = new PrivateDirectory(root); } catch { throw storage(); }
  }

  private async load(petID: string): Promise<{ state: CharacterState; source: Source }> {
    try {
      const source = await this.directory.read(`${petID}.json`, CHARACTER_LIMIT, () => this.observed.add(petID));
      if (!source) {
        if (this.observed.has(petID)) throw storage();
        return { state: empty(petID), source };
      }
      const document: unknown = JSON.parse(decoder.decode(source.bytes));
      // This is an app-owned format. A compact roundtrip also rejects duplicate
      // JSON keys, malformed UTF-8 and non-canonical escapes instead of normalizing them on save.
      if (!isState(document, petID) || !encoder(document).equals(source.bytes)) throw storage();
      return { state: document, source };
    } catch { throw storage(); }
  }

  async read(petID: unknown): Promise<CharacterState> {
    if (!petId(petID)) throw invalid();
    return (await this.load(petID)).state;
  }

  /** Run under the workspace instance queue; uncertain writes cannot feed online context. */
  async readForOnlineChat(petID: string): Promise<CharacterState> {
    const requireConfirmed = () => {
      if (this.uncertain.has(petID) || this.onlineUnconfirmed.has(petID)) throw new CharacterError('character_publication_uncertain');
    };
    requireConfirmed();
    const state = await this.read(petID);
    requireConfirmed();
    return state;
  }

  async apply(petID: unknown, expectedRevision: unknown, input: unknown): Promise<Publication> {
    if (!petId(petID) || !revision(expectedRevision) || !isCommand(input)) throw invalid();
    if (!this.acceptingWrites) throw storage();
    const command = structuredClone(input);
    const op = this.queue.then(() => this.write(petID, expectedRevision, command));
    this.queue = op.catch(() => {});
    return op;
  }

  private async releaseLock(name: string): Promise<void> {
    const lock = this.pendingLocks.get(name);
    if (!lock) return;
    // Retain the descriptor on failure, so a later attempt cannot mistake a
    // reused inode for this lock. Another repository cannot take it over.
    await this.directory.removeOwned(name, lock.info);
    this.pendingLocks.delete(name);
    await lock.handle.close();
  }

  close(): Promise<void> {
    this.acceptingWrites = false;
    if (this.closing) return this.closing;
    const attempt = this.queue.then(async () => {
      let failed = false;
      for (const name of this.pendingLocks.keys()) {
        try { await this.releaseLock(name); }
        catch { failed = true; }
      }
      if (failed) throw storage();
    });
    this.closing = attempt;
    // Keep lock ownership after a failed close. A caller can retry cleanup
    // while the repository remains permanently closed to writes.
    void attempt.catch(() => { this.closing = undefined; });
    return attempt;
  }

  private async write(petID: string, expected: number, command: Command): Promise<Publication> {
    const name = `${petID}.json`, lockName = `.${petID}.lock`, temporary = `.character-${randomUUID()}.tmp`;
    let lock: FileHandle | undefined, tmp: FileHandle | undefined, tmpInfo: Stats | undefined;
    let published = false;
    const uncertain = () => {
      this.uncertain.add(petID);
      return new CharacterError('character_publication_uncertain');
    };
    try {
      if (this.uncertain.has(petID)) throw uncertain();
      await this.releaseLock(lockName);
      try {
        lock = await this.directory.create(lockName);
        this.pendingLocks.set(lockName, { handle: lock, info: await lock.stat() });
        lock = undefined;
      }
      catch (e) { if (e && typeof e === 'object' && 'code' in e && e.code === 'EEXIST') throw new CharacterError('character_busy'); throw e; }
      const { state, source } = await this.load(petID);
      if (state.revision !== expected || !revision(state.revision + 1)) throw new CharacterError('character_conflict');
      transition(state, command, (this.options.clock?.() ?? new Date()).toISOString());
      if (state.revision === expected) return { state, durability: 'unchanged' };
      if (!isState(state, petID)) throw invalid();
      const bytes = encoder(state);
      if (bytes.length > CHARACTER_LIMIT) throw new CharacterError('character_limit');
      tmp = await this.directory.create(temporary); tmpInfo = await tmp.stat();
      await tmp.writeFile(bytes); await tmp.sync(); await tmp.close(); tmp = undefined;
      const prepared = await this.directory.read(temporary, CHARACTER_LIMIT);
      if (!prepared || !sameFile(prepared.info, tmpInfo) || !prepared.bytes.equals(bytes)) throw storage();
      if (!unchanged(source, (await this.load(petID)).source)) throw new CharacterError('character_conflict');
      let durability: Publication['durability'] = 'confirmed';
      try { await (this.options.io?.rename ?? rename)(this.directory.path(temporary), this.directory.path(name)); }
      catch {
        // An adapter may fail after publication. Reconcile by the inode and
        // bytes of the staged file; never retry an indeterminate publication.
        let after: Source;
        try { after = await this.directory.read(name, CHARACTER_LIMIT); } catch { throw uncertain(); }
        if (unchanged(prepared, after)) durability = 'unconfirmed';
        else if (unchanged(source, after)) throw storage();
        else throw uncertain();
      }
      published = true;
      this.observed.add(petID);
      try { await (this.options.io?.syncDirectory?.() ?? this.directory.sync()); } catch { durability = 'unconfirmed'; }
      if (durability === 'unconfirmed') this.onlineUnconfirmed.add(petID);
      return { state, durability };
    } catch (e) {
      if (e instanceof CharacterError) throw e;
      throw storage();
    } finally {
      await tmp?.close().catch(() => {});
      if (!published && tmpInfo) await this.directory.removeOwned(temporary, tmpInfo).catch(() => {});
      await this.releaseLock(lockName).catch(() => {});
      await lock?.close().catch(() => {});
    }
  }
}
