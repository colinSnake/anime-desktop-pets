import { randomBytes } from 'node:crypto';
import { lstat, rename, type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type { ModelConfiguration } from './types.ts';
import { ModelError } from './errors.ts';
import { validateConfiguration } from './config.ts';
import { isVaultReference } from './credentials.ts';
import { PrivateDirectory, sameFile, absent } from './private-directory.ts';
const authorityBrand = Symbol('model-online-authority');
export type OnlineAuthority = Readonly<{ [authorityBrand]: true }>;
export type CommitOptions = { authority?: OnlineAuthority; onPublished?: (state: ModelConfiguration) => void; onUncertain?: () => void };
export type Publication = { configuration: ModelConfiguration; durability: 'confirmed' | 'unconfirmed' };
/** Trusted filesystem adapter; never exposed through IPC. */
export type PublicationIO = { rename?: typeof rename; syncDirectory?: () => Promise<void> };
export const MODEL_CONFIGURATION_LIMIT = 1_048_576;
const FILE = 'model-providers.json', LOCK = '.models-writer.lock', ONLINE = '.models-online-owner.lock';
const empty = (): ModelConfiguration => ({ schemaVersion: 2, revision: 0, defaultConnectionID: null, connections: [] });
const storage = () => new ModelError('storage_unavailable');
const validReferences = (state: ModelConfiguration) => state.connections.every(c => c.credentialRef === undefined || isVaultReference(c.credentialRef));
export function decodeModelConfiguration(bytes: Buffer): ModelConfiguration {
  const configuration = validateConfiguration(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  if (!validReferences(configuration) || configuration.connections.some(c => c.revision > configuration.revision)) throw storage();
  return configuration;
}
export class ModelConfigurationStore {
  private readonly directory: PrivateDirectory;
  private observed = false;
  private authority?: { handle: FileHandle; identity: Stats; token: OnlineAuthority };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(root: string, private readonly io: PublicationIO = {}) { this.directory = new PrivateDirectory(root); }
  private async load() {
    try {
      const result = await this.directory.read(FILE, MODEL_CONFIGURATION_LIMIT);
      if (!result) { if (this.observed) throw storage(); return { configuration: empty(), source: undefined }; }
      this.observed = true;
      const configuration = decodeModelConfiguration(result.bytes);
      return { configuration, source: result };
    } catch { this.observed = true; throw storage(); }
  }
  async read(): Promise<ModelConfiguration> { return (await this.load()).configuration; }
  private async checkAuthority(token?: OnlineAuthority): Promise<void> {
    const current = await lstat(this.directory.path(ONLINE)).catch(e => { if (absent(e)) return undefined; throw e; });
    if (this.authority) {
      if (token !== this.authority.token) throw new ModelError('busy');
      if (!current || !sameFile(current, this.authority.identity)) throw storage();
      await this.directory.read(ONLINE, 0);
    } else if (current || token) throw new ModelError('busy');
  }
  /** A separate lifetime ownership marker covers BOTH online requests and all
   * configuration writers. It is not the short publication lock, and is never
   * stolen after a crash. Offline stores may read but cannot publish past it. */
  acquireOnlineAuthority(): Promise<{ configuration: ModelConfiguration; authority: OnlineAuthority }> {
    const operation = this.queue.then(async () => {
      let lock: FileHandle | undefined, identity: Stats | undefined;
      try {
        await this.directory.ready();
        try { lock = await this.directory.create(LOCK); identity = await lock.stat(); }
        catch (e) { if (e && typeof e === 'object' && 'code' in e && e.code === 'EEXIST') throw new ModelError('busy'); throw e; }
        if (this.authority) throw new ModelError('busy');
        await this.checkAuthority(); const state = (await this.load()).configuration;
        const handle = await this.directory.create(ONLINE);
        const token: OnlineAuthority = Object.freeze({ [authorityBrand]: true });
        this.authority = { handle, identity: await handle.stat(), token }; return { configuration: state, authority: token };
      } catch (e) { if (e instanceof ModelError) throw e; throw storage(); }
      finally {
        if (lock && identity) await this.directory.removeOwned(LOCK, identity).catch(() => {});
        await lock?.close().catch(() => {});
      }
    });
    this.queue = operation.catch(() => {}); return operation;
  }
  releaseOnlineAuthority(token: OnlineAuthority): Promise<void> {
    const operation = this.queue.then(async () => {
      const owned = this.authority;
      if (!owned || owned.token !== token) throw new ModelError('busy');
      let lock: FileHandle | undefined, identity: Stats | undefined;
      try {
        await this.directory.ready();
        try { lock = await this.directory.create(LOCK); identity = await lock.stat(); }
        catch (e) { if (e && typeof e === 'object' && 'code' in e && e.code === 'EEXIST') throw new ModelError('busy'); throw e; }
        await this.directory.removeOwned(ONLINE, owned.identity);
      } catch (e) {
        // Missing profile means the owned marker is also gone. Other failures
        // retain ownership and the open handle so an explicit close can retry.
        if (!absent(e)) { if (e instanceof ModelError) throw e; throw storage(); }
      } finally {
        if (lock && identity) await this.directory.removeOwned(LOCK, identity).catch(() => {});
        await lock?.close().catch(() => {});
      }
      this.authority = undefined;
      await owned.handle.close().catch(() => {});
    });
    this.queue = operation.catch(() => {}); return operation;
  }
  /** Transform is synchronous, must be pure, and runs under a short writer lock.
   * Keys/network are prepared outside this transaction. No stale lock takeover. */
  commit(expectedRevision: number | undefined, transform: (state: ModelConfiguration) => unknown, options: CommitOptions = {}): Promise<Publication> {
    const operation = this.queue.then(() => this.transaction(expectedRevision, transform, options));
    this.queue = operation.catch(() => {}); return operation;
  }
  private async transaction(expectedRevision: number | undefined, transform: (state: ModelConfiguration) => unknown, options: CommitOptions = {}): Promise<Publication> {
    let lock: FileHandle | undefined, lockIdentity: Stats | undefined, tmp: FileHandle | undefined, tmpIdentity: Stats | undefined;
    const temporary = `.models-${randomBytes(16).toString('hex')}.tmp`;
    let published: ModelConfiguration | undefined;
    try {
      await this.directory.ready();
      try { lock = await this.directory.create(LOCK); lockIdentity = await lock.stat(); }
      catch (e) { if (e && typeof e === 'object' && 'code' in e && e.code === 'EEXIST') throw new ModelError('busy'); throw e; }
      await this.checkAuthority(options.authority);
      const before = await this.load();
      if ((expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision !== before.configuration.revision)) || before.configuration.revision === Number.MAX_SAFE_INTEGER) throw new ModelError('configuration_conflict');
      const candidate = validateConfiguration(transform(structuredClone(before.configuration)));
      candidate.revision = before.configuration.revision + 1;
      if (!validReferences(candidate) || candidate.connections.some(c => c.revision > candidate.revision)) throw new ModelError('invalid_configuration');
      const bytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
      if (bytes.length > MODEL_CONFIGURATION_LIMIT) throw new ModelError('invalid_configuration');
      tmp = await this.directory.create(temporary); tmpIdentity = await tmp.stat();
      await tmp.writeFile(bytes); await tmp.sync(); await tmp.close(); tmp = undefined;
      const current = await this.load();
      // Protect even same-revision edits and disappearance/replacement by an
      // uncooperative writer. Cooperating writers share the short lock above.
      if (before.source ? !current.source || !sameFile(before.source.info, current.source.info) || !before.source.bytes.equals(current.source.bytes) : !!current.source) throw new ModelError('configuration_conflict');
      const prepared = await this.directory.read(temporary, MODEL_CONFIGURATION_LIMIT);
      if (!prepared || !tmpIdentity || !sameFile(tmpIdentity, prepared.info) || !prepared.bytes.equals(bytes)) throw storage();
      let renameUncertain = false;
      try { await (this.io.rename ?? rename)(this.directory.path(temporary), this.directory.path(FILE)); }
      catch {
        // Even a trusted adapter can report an error after the OS publication.
        // Reconcile using the prepared inode AND exact bytes, never revision
        // alone. An indeterminate outcome must retain its credential version.
        let after: Awaited<ReturnType<PrivateDirectory['read']>>;
        try { after = await this.directory.read(FILE, MODEL_CONFIGURATION_LIMIT); }
        catch { throw new ModelError('publication_uncertain'); }
        if (after && tmpIdentity && sameFile(tmpIdentity, after.info) && after.bytes.equals(bytes)) renameUncertain = true;
        else if (before.source ? after && sameFile(before.source.info, after.info) && before.source.bytes.equals(after.bytes) : !after) throw storage();
        else throw new ModelError('publication_uncertain');
      }
      published = candidate; this.observed = true; // no failure after this point may imply rollback
      // The owning repository publishes memory/revocation synchronously before
      // awaiting durability. A callback failure cannot undo the disk commit.
      try { options.onPublished?.(structuredClone(candidate)); } catch { /* caller must fail closed */ }
      let durability: Publication['durability'] = renameUncertain ? 'unconfirmed' : 'confirmed';
      try { await (this.io.syncDirectory ? this.io.syncDirectory() : this.directory.sync()); } catch { durability = 'unconfirmed'; }
      return { configuration: structuredClone(candidate), durability };
    } catch (e) {
      if (e instanceof ModelError && e.code === 'publication_uncertain') {
        try { options.onUncertain?.(); } catch { /* uncertainty cannot be rolled back */ }
      }
      if (e instanceof ModelError) throw e;
      throw storage();
    } finally {
      // An uncertain cleanup must never turn an already-published transaction
      // into a failure that would cause callers to delete its new credential.
      await tmp?.close().catch(() => {});
      if (!published && tmpIdentity) await this.directory.removeOwned(temporary, tmpIdentity).catch(() => {});
      if (lock && lockIdentity) await this.directory.removeOwned(LOCK, lockIdentity).catch(() => {});
      await lock?.close().catch(() => {});
    }
  }
}
