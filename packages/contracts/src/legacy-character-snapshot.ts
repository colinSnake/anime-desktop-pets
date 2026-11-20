import { GOAL_LIMIT, MEMORY_LIMIT, credentialLike, isGoalDraft, isMemoryDraft, recordID, within, type GoalDraft, type MemoryDraft } from './character-records.ts';
import { identityRecordLimit, isIdentityDraft, type IdentityDraft } from './characters.ts';
import { petId, revision, shape } from './pets.ts';

export type SnapshotRecordCount = { recognized: number; invalid: number };
export type LegacyCharacterSnapshotReport = {
  identity: 'missing' | 'recognized' | 'invalid';
  memories: SnapshotRecordCount;
  goals: SnapshotRecordCount;
};
export type LegacyCharacterSnapshotResult = { ok: true; report: LegacyCharacterSnapshotReport } | {
  ok: false; error: 'cancelled' | 'busy' | 'empty' | 'unsafe' | 'changed' | 'limit' | 'unavailable';
};

export const legacyHandoffBodyLimit = identityRecordLimit + 1024;
export type LegacyImportBatch = { identity: IdentityDraft | null; memories: MemoryDraft[]; goals: GoalDraft[] };
export const isLegacyImportMemory = (value: unknown): value is MemoryDraft => isMemoryDraft(value) && !credentialLike(value);
export const isLegacyImportGoal = (value: unknown): value is GoalDraft => isGoalDraft(value) && value.steps.every(step => step.id === undefined);
export function isLegacyImportBatch(value: unknown): value is LegacyImportBatch {
  return shape(value, ['identity', 'memories', 'goals']) && (value.identity === null || isIdentityDraft(value.identity)) &&
    within(value.memories, MEMORY_LIMIT, isLegacyImportMemory) && within(value.goals, GOAL_LIMIT, isLegacyImportGoal) &&
    (value.identity !== null || value.memories.length + value.goals.length > 0);
}

export type LegacyHandoffStatus = { revision: number; mode: 'empty' | 'occupied' | 'undoable' };
export type LegacyHandoffReply = { ok: true; status: LegacyHandoffStatus } | {
  ok: false; error: 'invalid' | 'not-found' | 'conflict' | 'busy' | 'limit' | 'write-outcome-unknown' | 'unavailable';
};
export type LegacyHandoffInput = { action: 'status' | 'select'; petID: string } |
  { action: 'import'; petID: string; ticket: string } | { action: 'undo'; petID: string; expectedRevision: number };
export type LegacyHandoffResult = LegacyHandoffReply | Extract<LegacyCharacterSnapshotResult, { ok: false }> |
  { ok: true; report: LegacyCharacterSnapshotReport; ticket?: string };
export type LegacyHandoffBridge = (input: LegacyHandoffInput) => Promise<LegacyHandoffResult>;
export function isLegacyHandoffInput(value: unknown): value is LegacyHandoffInput {
  if (!shape(value, ['action', 'petID', 'ticket', 'expectedRevision']) || !petId(value.petID)) return false;
  switch (value.action) {
    case 'select': case 'status': return shape(value, ['action', 'petID']);
    case 'import': return shape(value, ['action', 'petID', 'ticket']) && recordID(value.ticket);
    case 'undo': return shape(value, ['action', 'petID', 'expectedRevision']) && revision(value.expectedRevision) && value.expectedRevision > 0;
    default: return false;
  }
}

export const legacyHandoffErrorStatus = { invalid: 400, 'not-found': 404, conflict: 409, busy: 409, limit: 413, 'write-outcome-unknown': 503, unavailable: 503 } as const;
export function isLegacyHandoffReply(value: unknown, status: number): value is LegacyHandoffReply {
  if (!shape(value, ['ok', 'status', 'error'])) return false;
  if (value.ok === false) return shape(value, ['ok', 'error']) && typeof value.error === 'string' && Object.hasOwn(legacyHandoffErrorStatus, value.error) &&
    status === legacyHandoffErrorStatus[value.error as keyof typeof legacyHandoffErrorStatus];
  return status === 200 && value.ok === true && shape(value, ['ok', 'status']) && shape(value.status, ['revision', 'mode']) &&
    revision(value.status.revision) && (value.status.mode === 'empty' || (value.status.revision > 0 && (value.status.mode === 'occupied' || value.status.mode === 'undoable')));
}
