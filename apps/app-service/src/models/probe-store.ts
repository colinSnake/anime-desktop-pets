import { randomUUID } from 'node:crypto';
import { rename, type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { MAX_MODEL_PROBE_RECORDS, validProbeRecord, type ModelProbeInput, type ModelProbeReply, type ModelProbeRecord } from '../../../../packages/contracts/src/model-probe.ts';
import { ModelError } from './errors.ts';
import { PrivateDirectory, sameFile } from './private-directory.ts';
import type { ModelConfiguration } from './types.ts';

export const MODEL_PROBE_FILE = 'model-probes.json', MODEL_PROBE_LIMIT = 1_048_576;
const storage = () => new ModelError('storage_unavailable');
const recordKey = ({ input }: ModelProbeRecord) => JSON.stringify([input.connectionID, input.expectedRevision, input.entryID, input.modelID, input.maxOutputTokens ?? null, input.outputTokenField ?? null]);
export function decodeModelProbeRecords(bytes: Buffer): ModelProbeRecord[] {
  try {
    if (bytes.length > MODEL_PROBE_LIMIT) throw storage();
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 ||
        !('schemaVersion' in value) || value.schemaVersion !== 1 || !('records' in value) || !Array.isArray(value.records) ||
        value.records.length > MAX_MODEL_PROBE_RECORDS || !value.records.every(validProbeRecord)) throw storage();
    const records = value.records as ModelProbeRecord[];
    if (new Set(records.map(recordKey)).size !== records.length) throw storage();
    return records;
  } catch { throw storage(); }
}
export function currentProbeRecords(records: readonly ModelProbeRecord[], state: ModelConfiguration): ModelProbeRecord[] {
  const revisions = new Map(state.connections.map(connection => [connection.id, connection.revision]));
  return records.filter(record => revisions.get(record.input.connectionID) === record.input.expectedRevision);
}

/** Separate from configuration: tests must not mutate saved routes or revisions. */
export class ModelProbeStore {
  private readonly directory: PrivateDirectory;
  private observed = false;
  private active?: Promise<ModelProbeReply>;
  constructor(root: string) { this.directory = new PrivateDirectory(root); }
  private async load() {
    const source = await this.directory.read(MODEL_PROBE_FILE, MODEL_PROBE_LIMIT);
    if (!source) { if (this.observed) throw storage(); return { records: [] as ModelProbeRecord[], source }; }
    this.observed = true;
    return { records: decodeModelProbeRecords(source.bytes), source };
  }
  async read(): Promise<ModelProbeRecord[]> {
    try { return (await this.load()).records; } catch { throw storage(); }
  }
  /** Hold only the receipt writer (not the configuration writer) across a possibly billed probe. */
  recordTest(input: ModelProbeInput, state: () => ModelConfiguration, signal: AbortSignal, probe: () => Promise<ModelProbeReply>): Promise<ModelProbeReply> {
    if (this.active) return Promise.reject(new ModelError('busy'));
    const operation = this.perform(input, state, signal, probe);
    this.active = operation;
    return operation.finally(() => { if (this.active === operation) this.active = undefined; });
  }
  async close(): Promise<void> { await this.active?.catch(() => {}); }
  private async perform(input: ModelProbeInput, state: () => ModelConfiguration, signal: AbortSignal, probe: () => Promise<ModelProbeReply>): Promise<ModelProbeReply> {
    let lock: FileHandle | undefined, identity: Stats | undefined, temporary: FileHandle | undefined, temporaryIdentity: Stats | undefined;
    const name = `.model-probes-${randomUUID()}.tmp`;
    try {
      if (signal.aborted) throw new ModelError('cancelled');
      try { lock = await this.directory.create('.model-probes-writer.lock'); identity = await lock.stat(); }
      catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') throw new ModelError('busy'); throw error; }
      const before = await this.load();
      await lock.sync(); await this.directory.sync();
      if (signal.aborted) throw new ModelError('cancelled');
      const result = await probe();
      if (signal.aborted) throw new ModelError('cancelled');
      const record: ModelProbeRecord = { input, result, testedAt: new Date().toISOString() };
      if (!validProbeRecord(record)) throw storage();
      const currentState = state();
      if (!currentProbeRecords([record], currentState).length) throw new ModelError('configuration_conflict');
      const records = currentProbeRecords(before.records, currentState).filter(item => recordKey(item) !== recordKey(record));
      records.push(record);
      const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, records: records.slice(-MAX_MODEL_PROBE_RECORDS) }) + '\n');
      if (bytes.length > MODEL_PROBE_LIMIT) throw storage();
      temporary = await this.directory.create(name); temporaryIdentity = await temporary.stat();
      await temporary.writeFile(bytes); await temporary.sync();
      const current = await this.directory.read(MODEL_PROBE_FILE, MODEL_PROBE_LIMIT);
      if (before.source ? !current || !sameFile(before.source.info, current.info) || !before.source.bytes.equals(current.bytes) : current) throw storage();
      if (signal.aborted) throw new ModelError('cancelled');
      try { await rename(this.directory.path(name), this.directory.path(MODEL_PROBE_FILE)); }
      catch {
        const after = await this.directory.read(MODEL_PROBE_FILE, MODEL_PROBE_LIMIT);
        if (!after || !sameFile(temporaryIdentity, after.info) || !bytes.equals(after.bytes)) throw new ModelError('publication_uncertain');
      }
      this.observed = true;
      await this.directory.sync();
      if (signal.aborted) throw new ModelError('cancelled');
      return result;
    } catch (error) { if (error instanceof ModelError) throw error; throw storage(); }
    finally {
      await temporary?.close().catch(() => {});
      if (temporaryIdentity) await this.directory.removeOwned(name, temporaryIdentity).catch(() => {});
      if (identity) await this.directory.removeOwned('.model-probes-writer.lock', identity).catch(() => {});
      await lock?.close().catch(() => {});
    }
  }
}
