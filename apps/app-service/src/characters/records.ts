import { shape, revision } from '../../../../packages/contracts/src/pets.ts';
import {
  MEMORY_LIMIT, GOAL_LIMIT, distinct, within, recordID, isMemoryDraft, isKnowledgeBatch, isGoalDraft, isMemory, isGoal,
  type Memory, type MemoryDraft, type KnowledgeDraft, type Goal, type GoalDraft, type RecordVersion,
} from '../../../../packages/contracts/src/character-records.ts';
export { MEMORY_LIMIT, GOAL_LIMIT, credentialLike } from '../../../../packages/contracts/src/character-records.ts';
export type { Memory, MemoryDraft, Goal, GoalDraft } from '../../../../packages/contracts/src/character-records.ts';
import { identityHistoryLimit, identityRecordLimit, isIdentityDraft, isIdentityRecord, type Identity, type IdentityDraft } from '../../../../packages/contracts/src/characters.ts';
export type { Identity, IdentityDraft } from '../../../../packages/contracts/src/characters.ts';

export const CHARACTER_LIMIT = identityRecordLimit;
export const HISTORY_LIMIT = identityHistoryLimit;
export class CharacterError extends Error {
  constructor(readonly code: 'invalid_character_data' | 'character_storage_unavailable' | 'character_conflict' | 'character_busy' | 'character_record_not_found' | 'character_publication_uncertain' | 'character_limit' | 'credential_like_memory' | 'memory_expired' | 'memory_duplicate' | 'knowledge_conflict') { super(code); }
}
export const invalid = () => new CharacterError('invalid_character_data');
export type CharacterState = { schemaVersion: 1; petID: string; revision: number; identity: Identity | null; identityHistory: Identity[]; memories: Array<{ current: Memory; history: Memory[] }>; goals: Goal[] };
export type Command =
  | { type: 'saveIdentity'; value: IdentityDraft }
  | { type: 'setIdentityChatShare'; enabled: boolean }
  | { type: 'setMemoryChatShare' | 'setGoalChatShare'; id: string; enabled: boolean }
  | { type: 'restoreIdentity'; revision: number }
  | { type: 'addMemory'; value: MemoryDraft }
  | { type: 'addKnowledgeBatch'; value: KnowledgeDraft[] }
  | { type: 'editMemory'; id: string; value: MemoryDraft }
  | { type: 'restoreMemory'; id: string; revision: number }
  | { type: 'confirmMemory' | 'withdrawMemory' | 'deleteMemory' | 'deleteGoal'; id: string }
  | { type: 'addGoal'; value: GoalDraft }
  | { type: 'editGoal'; id: string; value: GoalDraft };

const positiveRevision = (v: unknown): v is number => revision(v) && v > 0;

/** Only complete DTOs cross the repository boundary; no caller revisions, owner fields, or grants in drafts. */
export function isCommand(v: unknown): v is Command {
  if (!shape(v, ['type', 'id', 'value', 'revision', 'enabled'])) return false;
  switch (v.type) {
    case 'setIdentityChatShare': return shape(v, ['type', 'enabled']) && typeof v.enabled === 'boolean';
    case 'setMemoryChatShare': case 'setGoalChatShare': return shape(v, ['type', 'id', 'enabled']) && recordID(v.id) && typeof v.enabled === 'boolean';
    case 'saveIdentity': return shape(v, ['type', 'value']) && isIdentityDraft(v.value);
    case 'restoreIdentity': return shape(v, ['type', 'revision']) && positiveRevision(v.revision);
    case 'addMemory': return shape(v, ['type', 'value']) && isMemoryDraft(v.value);
    case 'addKnowledgeBatch': return shape(v, ['type', 'value']) && isKnowledgeBatch(v.value);
    case 'editMemory': return shape(v, ['type', 'id', 'value']) && recordID(v.id) && isMemoryDraft(v.value);
    case 'restoreMemory': return shape(v, ['type', 'id', 'revision']) && recordID(v.id) && positiveRevision(v.revision);
    case 'confirmMemory': case 'withdrawMemory': case 'deleteMemory': case 'deleteGoal': return shape(v, ['type', 'id']) && recordID(v.id);
    case 'addGoal': return shape(v, ['type', 'value']) && isGoalDraft(v.value) && v.value.steps.every(s => s.id === undefined);
    case 'editGoal': return shape(v, ['type', 'id', 'value']) && recordID(v.id) && isGoalDraft(v.value);
    default: return false;
  }
}
const trail = <T extends RecordVersion>(current: T, history: T[]) => history.every((record, i) =>
  record.revision === current.revision - history.length + i && record.createdAt === current.createdAt && record.updatedAt <= (history[i+1] ?? current).updatedAt);
const memoryTrail = (v: unknown): v is CharacterState['memories'][number] => shape(v, ['current', 'history']) && isMemory(v.current) &&
  within(v.history, HISTORY_LIMIT, isMemory) && trail(v.current, v.history) && v.history.every(m => m.chatShare === undefined && m.id === (v.current as Memory).id);

export function isState(v: unknown, petID: string): v is CharacterState {
  if (!(shape(v, ['schemaVersion', 'petID', 'revision', 'identity', 'identityHistory', 'memories', 'goals']) &&
    v.schemaVersion === 1 && v.petID === petID && positiveRevision(v.revision) && (v.identity === null || isIdentityRecord(v.identity)) &&
    within(v.identityHistory, HISTORY_LIMIT, isIdentityRecord) && within(v.memories, MEMORY_LIMIT, memoryTrail) && within(v.goals, GOAL_LIMIT, isGoal))) return false;
  return (v.identity ? trail(v.identity, v.identityHistory) : v.identityHistory.length === 0) &&
    v.identityHistory.every(record => record.chatShare === undefined) && distinct(v.memories.map(m => m.current.id)) &&
    distinct(v.goals.map(g => g.id)) && [v.identity, ...v.memories.map(m => m.current), ...v.goals].every(record => !record || record.revision <= (v.revision as number));
}
