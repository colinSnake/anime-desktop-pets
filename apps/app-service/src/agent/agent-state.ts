import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { link, lstat } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { validChatRequestID } from '../../../../packages/contracts/src/online-chat.ts';
import { petId, shape } from '../../../../packages/contracts/src/pets.ts';
import { ModelError } from '../models/errors.ts';
import { PrivateDirectory, sameFile } from '../models/private-directory.ts';

const databaseName = 'agent-state.sqlite';
const configName = 'agent.json';
const configLimit = 4096;
const applicationID = 0x41445041;
const schema = `CREATE TABLE runs (
  request_id TEXT PRIMARY KEY,
  pet_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('chat', 'voice', 'live', 'task')),
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')),
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT`;
const sources = ['chat', 'voice', 'live', 'task'] as const;
const terminalStatuses = ['completed', 'failed', 'cancelled', 'interrupted'] as const;
export type AgentSource = typeof sources[number];
export type RunTerminalStatus = typeof terminalStatuses[number];
export type RunStatus = 'running' | RunTerminalStatus;
export type AgentDefinition = { schemaVersion: 1; id: string; runtime: 'pi'; enabled: true; skills: [] };
export type RunRecord = { requestID: string; petID: string; source: AgentSource; status: RunStatus; startedAt: number; updatedAt: number };
export type BeginRunInput = { requestID: string; petID: string; source: AgentSource };
const invalid = () => new ModelError('invalid_request');
const storage = () => new ModelError('storage_unavailable');
const isSource = (value: unknown): value is AgentSource => sources.some(source => value === source);
const isTerminal = (value: unknown): value is RunTerminalStatus => terminalStatuses.some(status => value === status);
const definitionFor = (id: string): AgentDefinition => ({ schemaVersion: 1, id, runtime: 'pi', enabled: true, skills: [] });
const isDefinition = (value: unknown, id: string): value is AgentDefinition =>
  shape(value, ['schemaVersion', 'id', 'runtime', 'enabled', 'skills']) && value.schemaVersion === 1 &&
  value.id === id && value.runtime === 'pi' && value.enabled === true && Array.isArray(value.skills) && value.skills.length === 0;
const decoder = new TextDecoder('utf-8', { fatal: true });

// This guard is process-local. The desktop bootstrap must await workspace.list()
// successfully (it takes the lifetime WorkspaceStore writer lease for this
// business root) before calling ready() or any other ledger operation. Keep
// that lease until after all Agent callers and this store have closed. A caller
// outside desktop bootstrap must provide equivalent exclusive profile ownership.
const owners = new Set<string>();

/** Private, payload-free agent configuration and run-state ledger. */
export class AgentStateStore {
  private readonly directory: PrivateDirectory;
  private readonly agents: PrivateDirectory;
  private readonly instances = new Map<string, PrivateDirectory>();
  private db?: DatabaseSync;
  private databaseIdentity?: Stats;
  private ownerKey?: string;
  private queue: Promise<unknown> = Promise.resolve();
  private closing?: Promise<void>;

  constructor(root: string) {
    this.directory = new PrivateDirectory(root);
    this.agents = new PrivateDirectory(this.directory.path('agents'));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new ModelError('closed'));
    const work = this.queue.then(operation).catch((error: unknown) => {
      if (error instanceof ModelError) throw error;
      throw storage();
    });
    this.queue = work.catch(() => {});
    return work;
  }

  private async verifySidecars() {
    // In DELETE mode a private rollback journal may be left by an interrupted
    // commit. SQLite can recover it; WAL/SHM are not part of this ledger.
    const journal = await this.directory.file(`${databaseName}-journal`);
    if (await this.directory.file(`${databaseName}-wal`) || await this.directory.file(`${databaseName}-shm`)) throw storage();
    return journal;
  }

  private async verifyDatabase() {
    await this.verifySidecars();
    const file = await this.directory.file(databaseName);
    if (!file || !this.databaseIdentity || !sameFile(this.databaseIdentity, file)) throw storage();
  }

  private async database(): Promise<DatabaseSync> {
    const db = this.db;
    if (db) { await this.verifyDatabase(); return db; }

    await this.directory.ready();
    const root = await lstat(this.directory.root, { bigint: true });
    const key = `${root.dev}:${root.ino}`;
    if (owners.has(key)) throw storage();
    owners.add(key);
    try {
      await this.agents.ready();
      const { DatabaseSync } = await import('node:sqlite');
      const journal = await this.verifySidecars();
      let file = await this.directory.file(databaseName);
      if (!file) {
        if (journal || this.databaseIdentity) throw storage();
        const handle = await this.directory.create(databaseName);
        try { this.databaseIdentity = await handle.stat(); await handle.sync(); }
        finally { await handle.close(); }
        await this.directory.sync();
        file = await this.directory.file(databaseName);
      }
      if (!file || (this.databaseIdentity && !sameFile(this.databaseIdentity, file))) throw storage();
      this.databaseIdentity = file;
      const opened = new DatabaseSync(this.directory.path(databaseName), { timeout: 0, allowExtension: false });
      try {
        await this.verifyDatabase();
        opened.exec('PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA synchronous=EXTRA; PRAGMA secure_delete=ON');
        if (opened.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') throw storage();
        const version = opened.prepare('PRAGMA user_version').get()?.user_version;
        const id = opened.prepare('PRAGMA application_id').get()?.application_id;
        const actual = opened.prepare('SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL').all();
        if (version === 0 && id === 0 && actual.length === 0) {
          opened.exec(`BEGIN IMMEDIATE; ${schema}; PRAGMA application_id=${applicationID}; PRAGMA user_version=1; COMMIT`);
        } else if (version !== 1 || id !== applicationID || actual.length !== 1 || actual[0]?.sql !== schema) throw storage();
        opened.exec('PRAGMA max_page_count=65536');
        opened.prepare("UPDATE runs SET status = 'interrupted', updated_at = max(updated_at, ?) WHERE status = 'running'").run(Date.now());
        this.ownerKey = key;
        this.db = opened;
        return opened;
      } catch (error) { opened.close(); throw error; }
    } catch (error) { owners.delete(key); throw error; }
  }

  private async publishDefinition(directory: PrivateDirectory, definition: AgentDefinition) {
    const temporary = `.agent-${randomUUID()}.tmp`;
    const handle = await directory.create(temporary);
    let identity: Stats | undefined;
    try {
      identity = await handle.stat();
      await handle.writeFile(`${JSON.stringify(definition)}\n`);
      await handle.sync();
      const prepared = await directory.file(temporary);
      if (!prepared || !sameFile(identity, prepared)) throw storage();
      // Publish only a complete file, without clobbering any destination,
      // including a symlink introduced after the initial absence check.
      await link(directory.path(temporary), directory.path(configName));
    } finally {
      try { await handle.close(); }
      finally { if (identity) await directory.removeOwned(temporary, identity); }
    }
    await directory.sync();
  }

  private async ensureDefinition(id: string): Promise<AgentDefinition> {
    await this.agents.ready();
    const instance = this.instances.get(id) ?? new PrivateDirectory(this.agents.path(id));
    await instance.ready();
    this.instances.set(id, instance);
    const current = await instance.read(configName, configLimit);
    if (current) {
      const value: unknown = JSON.parse(decoder.decode(current.bytes));
      if (!isDefinition(value, id)) throw storage();
    } else {
      await this.publishDefinition(instance, definitionFor(id));
      const published = await instance.read(configName, configLimit);
      if (!published || !isDefinition(JSON.parse(decoder.decode(published.bytes)), id)) throw storage();
    }
    return definitionFor(id);
  }

  ready(): Promise<void> { return this.enqueue(async () => { await this.database(); }); }

  async ensureAgent(petID: string): Promise<AgentDefinition> {
    if (!petId(petID)) throw invalid();
    return this.enqueue(async () => {
      await this.database();
      return this.ensureDefinition(petID);
    });
  }

  async begin(input: BeginRunInput): Promise<void> {
    if (!shape(input, ['requestID', 'petID', 'source'])) throw invalid();
    const { requestID, petID, source } = input;
    if (!validChatRequestID(requestID) || !petId(petID) || !isSource(source)) throw invalid();
    return this.enqueue(async () => {
      const db = await this.database();
      if (db.prepare('SELECT 1 FROM runs WHERE request_id = ?').get(requestID)) throw invalid();
      await this.ensureDefinition(petID);
      await this.verifyDatabase();
      const now = Date.now();
      const result = db.prepare(`INSERT INTO runs(request_id, pet_id, source, status, started_at, updated_at)
        VALUES (?, ?, ?, 'running', ?, ?) ON CONFLICT(request_id) DO NOTHING`).run(requestID, petID, source, now, now);
      if (!result.changes) throw invalid();
    });
  }

  async finish(requestID: string, status: RunTerminalStatus, signal?: AbortSignal): Promise<void> {
    if (!validChatRequestID(requestID) || !isTerminal(status)) throw invalid();
    return this.enqueue(async () => {
      const db = await this.database();
      if (signal?.aborted) throw new ModelError('cancelled');
      const result = db.prepare("UPDATE runs SET status = ?, updated_at = max(updated_at, ?) WHERE request_id = ? AND status = 'running'").run(status, Date.now(), requestID);
      if (!result.changes && db.prepare('SELECT status FROM runs WHERE request_id = ?').get(requestID)?.status !== status) throw invalid();
    });
  }

  async status(requestID: string): Promise<RunRecord | undefined> {
    if (!validChatRequestID(requestID)) throw invalid();
    return this.enqueue(async () => {
      const db = await this.database();
      const row = db.prepare('SELECT pet_id, source, status, started_at, updated_at FROM runs WHERE request_id = ?').get(requestID);
      if (!row) return undefined;
      const { pet_id: petID, source, status, started_at: startedAt, updated_at: updatedAt } = row;
      if (!petId(petID) || !isSource(source) || (status !== 'running' && !isTerminal(status)) ||
        typeof startedAt !== 'number' || !Number.isSafeInteger(startedAt) || startedAt < 0 ||
        typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt) || updatedAt < startedAt) throw storage();
      return { requestID, petID, source, status, startedAt, updatedAt };
    });
  }

  close(): Promise<void> {
    this.closing ??= this.queue.then(() => {
      try { this.db?.close(); }
      catch { throw storage(); }
      this.db = undefined;
      if (this.ownerKey) owners.delete(this.ownerKey);
      this.ownerKey = undefined;
    });
    return this.closing;
  }
}
