import { randomUUID } from 'node:crypto';
import { isLegacyHandoffInput, type LegacyHandoffReply, type LegacyHandoffResult, type LegacyImportBatch } from '../../../packages/contracts/src/legacy-character-snapshot.ts';
import type { LegacyHandoffWrite } from './character-transport.ts';
import { inspectLegacyCharacterSnapshot } from './legacy-character-snapshot.ts';

const unavailable = { ok: false, error: 'unavailable' } as const;
const conflict = { ok: false, error: 'conflict' } as const;
type Staged = { petID: string; revision: number; ticket: string; value: LegacyImportBatch; expires: number };

/** One private snapshot, scoped to one workbench and one target revision. */
export class LegacyCharacterHandoff {
  private busy = false;
  private generation = 0;
  private staged?: Staged;
  private expiry?: ReturnType<typeof setTimeout>;
  constructor(private readonly appData: string, private readonly request: (petID: string, write?: LegacyHandoffWrite) => Promise<LegacyHandoffReply>,
    private readonly leaseMs = 5 * 60 * 1000) {}

  invalidate() {
    this.generation++;
    this.staged = undefined;
    clearTimeout(this.expiry);
  }

  async handle(input: unknown, choose: () => Promise<{ canceled: boolean; filePaths: string[] }>, isCurrent: () => boolean): Promise<LegacyHandoffResult> {
    if (!isLegacyHandoffInput(input)) return { ok: false, error: 'invalid' };
    if (!isCurrent()) return unavailable;
    if (this.busy) return { ok: false, error: 'busy' };
    this.busy = true;
    if (input.action === 'select' || input.action === 'undo') this.invalidate();
    const generation = this.generation;
    const current = () => generation === this.generation && isCurrent();
    const { petID } = input;
    try {
      switch (input.action) {
        case 'status': {
          const result = await this.request(petID);
          return current() ? result : unavailable;
        }
        case 'select': {
          const target = await this.request(petID);
          if (!current()) return unavailable;
          if (!target.ok) return target;
          if (target.status.mode !== 'empty') return conflict;
          let batch: LegacyImportBatch | undefined;
          const { canceled, filePaths } = await choose();
          if (!current()) return unavailable;
          if (canceled) return { ok: false, error: 'cancelled' };
          if (filePaths.length !== 1 || !filePaths[0]) return { ok: false, error: 'unsafe' };
          const result = await inspectLegacyCharacterSnapshot(filePaths[0], this.appData, new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), current,
            value => { batch = value; });
          if (!current()) return unavailable;
          if (!result.ok || !batch) return result;
          const ticket = randomUUID();
          this.staged = { petID, revision: target.status.revision, ticket, value: batch, expires: Date.now() + this.leaseMs };
          this.expiry = setTimeout(() => this.invalidate(), this.leaseMs).unref();
          return { ...result, ticket };
        }
        case 'import': {
          const { staged } = this;
          if (!staged || staged.petID !== petID || staged.ticket !== input.ticket || staged.expires <= Date.now()) return conflict;
          // Consume even on failure. Reconcile uncertainty by reading; never replay the write.
          this.staged = undefined;
          clearTimeout(this.expiry);
          const result = await this.request(petID, { expectedRevision: staged.revision, command: { type: 'importLegacy', value: staged.value } });
          return current() ? result : { ok: false, error: 'write-outcome-unknown' };
        }
        case 'undo': {
          const result = await this.request(petID, { expectedRevision: input.expectedRevision, command: { type: 'undoLegacyImport' } });
          return current() ? result : { ok: false, error: 'write-outcome-unknown' };
        }
      }
    } catch { return input.action === 'import' || input.action === 'undo' ? { ok: false, error: 'write-outcome-unknown' } : unavailable; }
    finally { this.busy = false; }
  }
}
