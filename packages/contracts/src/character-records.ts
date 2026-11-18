import { object, petId, revision, shape } from './pets.ts';
import { identityHistoryLimit, type ChatShare } from './characters.ts';

export const MEMORY_LIMIT = 64;
export const KNOWLEDGE_IMPORT_BYTES = 32 * 1024;
export const KNOWLEDGE_IMPORT_LIMIT = 50;
export const GOAL_LIMIT = 32;
export const goalStepLimit = 50;
export const memoryKinds = ['事实', '偏好', '经历', '知识'] as const;
export const goalStatuses = ['进行中', '已暂停', '已完成'] as const;
const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
function count(value: string) {
  let length = 0;
  for (const _ of segmenter.segment(value)) length++;
  return length;
}
export type MemoryDraft = { kind: (typeof memoryKinds)[number]; text: string; source: string; citation: string; version: string; expiresAt?: string };
export type KnowledgeDraft = MemoryDraft & { kind: '知识' };
export type GoalDraft = { title: string; details: string; status: (typeof goalStatuses)[number]; steps: ReadonlyArray<{ id?: string; text: string; isComplete: boolean }> };
export type RecordVersion = { revision: number; createdAt: string; updatedAt: string };
export type Memory = MemoryDraft & RecordVersion & ChatShare & { id: string } & ({ status: 'confirmed'; confirmedAt: string } | { status: 'candidate'; confirmedAt?: never });
export type Goal = Omit<GoalDraft, 'steps'> & RecordVersion & ChatShare & { id: string; steps: Array<Required<GoalDraft['steps'][number]>> };

function text(v: unknown, max: number, required = false, multiline = false): v is string {
  return typeof v === 'string' && v.length <= max * 16 && (!required || !!v.trim()) &&
    !/[\p{Cs}\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(v) && (multiline || !/[\t\n\u2028\u2029]/u.test(v)) && count(v) <= max;
}
function iso(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
}
export const recordID = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const version = (v: unknown): v is number => revision(v) && v > 0;
const versionFields = ['revision', 'createdAt', 'updatedAt', 'chatShare'];
const memoryFields = ['kind', 'text', 'source', 'citation', 'version', 'expiresAt'];
const goalFields = ['title', 'details', 'status', 'steps'];
const fields = (v: Record<string, unknown>): boolean => (v.chatShare === undefined || v.chatShare === true) && version(v.revision) && iso(v.createdAt) && iso(v.updatedAt) && v.createdAt <= v.updatedAt;
export const within = <T>(v: unknown, max: number, guard: (item: unknown) => item is T): v is T[] =>
  Array.isArray(v) && v.length <= max && Array.from(v).every(guard);
export const distinct = <T>(values: readonly T[]) => new Set(values).size === values.length;
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): v is T => typeof v === 'string' && allowed.includes(v as T);

export function isMemoryDraft(v: unknown, extra: string[] = []): v is MemoryDraft {
  return shape(v, [...memoryFields, ...extra]) && oneOf(v.kind, memoryKinds) && text(v.text, 1000, true, true) &&
    text(v.source, 200) && text(v.citation, 500) && text(v.version, 80) && (v.expiresAt === undefined || (v.kind === '知识' && iso(v.expiresAt)));
}
export function credentialLike(v: MemoryDraft): boolean {
  return credentialLikeText([v.text, v.source, v.citation, v.version].join(' '));
}
export function credentialLikeText(text: string): boolean {
  const content = text.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '');
  return /密码|密钥|验证码|私钥|助记词|api[\s_-]*key|token|cookie|password|private[\s_-]*key|\bbearer\s+\S/iu.test(content) ||
    /(?:sk-[\w-]{12,}|AIza[\w-]{35}|gh[pousr]_[\w]{20,}|xox[baprs]-[\w-]{12,}|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,})/iu.test(content);
}
const encoder = new TextEncoder();
const boundedParagraphs = (paragraphs: string[]) => paragraphs.length > 0 &&
  paragraphs.reduce((sum, paragraph) => sum + encoder.encode(paragraph).byteLength, 0) <= KNOWLEDGE_IMPORT_BYTES;
export const isKnowledgeParagraphs = (value: unknown): value is string[] =>
  within(value, KNOWLEDGE_IMPORT_LIMIT, (paragraph): paragraph is string => text(paragraph, 1000, true, true)) && boundedParagraphs(value);
export const isKnowledgeBatch = (value: unknown): value is KnowledgeDraft[] =>
  within(value, KNOWLEDGE_IMPORT_LIMIT, (draft): draft is KnowledgeDraft => isMemoryDraft(draft) && draft.kind === '知识' && !!draft.source.trim()) &&
  boundedParagraphs(value.map(draft => draft.text));
export const normalizeMemoryText = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\p{Z}\p{P}\p{S}\p{Default_Ignorable_Code_Point}\s]/gu, '');
export function knowledgeCollision(value: MemoryDraft) {
  if (value.kind !== '知识') return;
  const source = normalizeMemoryText(value.source), citation = normalizeMemoryText(value.citation);
  if (source && citation) return JSON.stringify([source, citation, normalizeMemoryText(value.version)]);
}
const step = (v: unknown): v is GoalDraft['steps'][number] => shape(v, ['id', 'text', 'isComplete']) &&
  (v.id === undefined || recordID(v.id)) && text(v.text, 500, true) && !/<!--|-->/.test(v.text) && typeof v.isComplete === 'boolean';
export function isGoalDraft(v: unknown, extra: string[] = []): v is GoalDraft {
  if (!(shape(v, [...goalFields, ...extra]) && text(v.title, 120, true) && text(v.details, 2000, false, true) &&
    oneOf(v.status, goalStatuses) && within(v.steps, goalStepLimit, step))) return false;
  return distinct(v.steps.flatMap(s => s.id === undefined ? [] : [s.id]));
}

export function isMemory(v: unknown): v is Memory {
  const extra = [...versionFields, 'id', 'status', 'confirmedAt'];
  return shape(v, [...memoryFields, ...extra]) && fields(v) && recordID(v.id) &&
    (v.status === 'candidate' ? v.confirmedAt === undefined && v.chatShare === undefined : v.status === 'confirmed' && iso(v.confirmedAt) && typeof v.updatedAt === 'string' && v.updatedAt <= v.confirmedAt && (!iso(v.expiresAt) || v.confirmedAt < v.expiresAt)) &&
    isMemoryDraft(v, extra) && !credentialLike(v);
}
export const isGoal = (v: unknown): v is Goal => shape(v, [...goalFields, ...versionFields, 'id']) && fields(v) && recordID(v.id) &&
  isGoalDraft(v, [...versionFields, 'id']) && v.steps.every(s => recordID(s.id));

export type RecordFamily = 'memories' | 'goals';
export type CharacterRecord = Memory | Goal;
export type RecordSnapshot<T extends CharacterRecord> = { schemaVersion: 1; petID: string; revision: number; records: T[] };
export type RecordReadResult<T extends CharacterRecord> = { ok: true; snapshot: RecordSnapshot<T> } | { ok: false; error: 'not-found' | 'unavailable' };
export type RecordError = 'invalid' | 'not-found' | 'record-not-found' | 'conflict' | 'busy' | 'limit' | 'unavailable' | 'write-outcome-unknown' |
  'credential-like' | 'expired' | 'duplicate' | 'knowledge-conflict';
export type RecordWriteResult<T extends CharacterRecord> = { ok: true; snapshot: RecordSnapshot<T>; durability: 'confirmed' | 'unconfirmed' | 'unchanged' } | { ok: false; error: RecordError };
export const recordErrorStatus: Record<RecordError, number> = {
  invalid: 400, 'not-found': 404, 'record-not-found': 404, conflict: 409, busy: 409, limit: 413, unavailable: 503, 'write-outcome-unknown': 503,
  'credential-like': 422, expired: 422, duplicate: 422, 'knowledge-conflict': 422,
};

export const recordRoutes = {
  readMemoryHistory: { family: 'memories', path: 'memories/history/:recordId', method: 'GET' },
  editMemory: { family: 'memories', path: 'memories/edit', method: 'POST' },
  restoreMemory: { family: 'memories', path: 'memories/restore', method: 'POST' },
  readMemories: { family: 'memories', path: 'memories', method: 'GET' },
  addKnowledgeBatch: { family: 'memories', path: 'memories/import', method: 'POST' },
  addMemory: { family: 'memories', path: 'memories/add', method: 'POST' },
  confirmMemory: { family: 'memories', path: 'memories/confirm', method: 'POST' },
  withdrawMemory: { family: 'memories', path: 'memories/withdraw', method: 'POST' },
  setMemoryChatShare: { family: 'memories', path: 'memories/chat-share', method: 'POST' },
  setGoalChatShare: { family: 'goals', path: 'goals/chat-share', method: 'POST' },
  deleteMemory: { family: 'memories', path: 'memories/delete', method: 'POST' },
  readGoals: { family: 'goals', path: 'goals', method: 'GET' },
  addGoal: { family: 'goals', path: 'goals/add', method: 'POST' },
  editGoal: { family: 'goals', path: 'goals/edit', method: 'POST' },
  deleteGoal: { family: 'goals', path: 'goals/delete', method: 'POST' },
} as const;
export type RecordAction = keyof typeof recordRoutes;
export const recordActions = Object.keys(recordRoutes) as RecordAction[];
export type ReadRecordInput = { petID: string };
export type RecordWriteInput = ReadRecordInput & { expectedRevision: number };
export type RecordDeleteInput = RecordWriteInput & { id: string };
export type RecordChatShareInput = RecordDeleteInput & { enabled: boolean };
export type MemoryHistoryInput = ReadRecordInput & { id: string };
export type MemoryHistorySnapshot = { schemaVersion: 1; petID: string; id: string; revision: number; currentRevision: number; history: Memory[] };
export type MemoryHistoryResult = { ok: true; snapshot: MemoryHistorySnapshot } | { ok: false; error: 'unavailable' | 'not-found' | 'record-not-found' };
export type RecordInputs = {
  readMemoryHistory: MemoryHistoryInput;
  editMemory: RecordWriteInput & { id: string; draft: MemoryDraft };
  restoreMemory: RecordWriteInput & { id: string; historicalRevision: number };
  addKnowledgeBatch: RecordWriteInput & { drafts: KnowledgeDraft[] };
  readMemories: ReadRecordInput; addMemory: RecordWriteInput & { draft: MemoryDraft };
  confirmMemory: RecordWriteInput & { id: string }; withdrawMemory: RecordWriteInput & { id: string };
  deleteMemory: RecordDeleteInput; deleteGoal: RecordDeleteInput;
  setMemoryChatShare: RecordChatShareInput; setGoalChatShare: RecordChatShareInput;
  readGoals: ReadRecordInput; addGoal: RecordWriteInput & { draft: GoalDraft }; editGoal: RecordWriteInput & { id: string; draft: GoalDraft };
};
export type RecordResult<A extends RecordAction> = A extends 'readMemoryHistory' ? MemoryHistoryResult : (typeof recordRoutes)[A] extends infer Route
  ? Route extends { family: infer Family; method: infer Method }
    ? (Method extends 'GET' ? RecordReadResult<Family extends 'memories' ? Memory : Goal> : RecordWriteResult<Family extends 'memories' ? Memory : Goal>)
    : never
  : never;
export type CharacterRecordsBridge = { [A in RecordAction]: (input: RecordInputs[A]) => Promise<RecordResult<A>> };
export const recordWriteLimit = 256 * 1024;

export function isRecordInput<A extends RecordAction>(action: A, value: unknown): value is RecordInputs[A] {
  if (!object(value) || !petId(value.petID)) return false;
  if (action === 'readMemoryHistory') return shape(value, ['petID', 'id']) && recordID(value.id);
  if (recordRoutes[action].method === 'GET') return shape(value, ['petID']);
  if (!revision(value.expectedRevision)) return false;
  switch (action) {
    case 'addMemory': case 'editMemory':
      if (!shape(value, action === 'addMemory' ? ['petID', 'expectedRevision', 'draft'] : ['petID', 'expectedRevision', 'draft', 'id']) ||
          (action === 'editMemory' && !recordID(value.id)) || !isMemoryDraft(value.draft) || (value.draft.kind === '知识' && !value.draft.source.trim())) return false;
      break;
    case 'addKnowledgeBatch':
      if (!shape(value, ['petID', 'expectedRevision', 'drafts']) || !isKnowledgeBatch(value.drafts)) return false;
      break;
    case 'restoreMemory':
      return shape(value, ['petID', 'expectedRevision', 'id', 'historicalRevision']) && recordID(value.id) && version(value.historicalRevision);
    case 'setMemoryChatShare': case 'setGoalChatShare':
      return shape(value, ['petID', 'expectedRevision', 'id', 'enabled']) && recordID(value.id) && typeof value.enabled === 'boolean';
    case 'confirmMemory': case 'withdrawMemory': case 'deleteMemory': case 'deleteGoal':
      return shape(value, ['petID', 'expectedRevision', 'id']) && recordID(value.id);
    case 'addGoal': case 'editGoal':
      if (!shape(value, action === 'addGoal' ? ['petID', 'expectedRevision', 'draft'] : ['petID', 'expectedRevision', 'draft', 'id']) || !isGoalDraft(value.draft) ||
        (action === 'addGoal' ? value.draft.steps.some(step => step.id !== undefined) : !recordID(value.id))) return false;
      break;
    default: return false;
  }
  return encoder.encode(JSON.stringify(value)).byteLength <= recordWriteLimit;
}

export function isRecordSnapshot(family: 'memories', value: unknown, petID: string): value is RecordSnapshot<Memory>;
export function isRecordSnapshot(family: 'goals', value: unknown, petID: string): value is RecordSnapshot<Goal>;
export function isRecordSnapshot(family: RecordFamily, value: unknown, petID: string): value is RecordSnapshot<CharacterRecord>;
export function isRecordSnapshot(family: RecordFamily, value: unknown, petID: string): value is RecordSnapshot<CharacterRecord> {
  if (!shape(value, ['schemaVersion', 'petID', 'revision', 'records']) || value.schemaVersion !== 1 || value.petID !== petID || !revision(value.revision)) return false;
  const bound = value.revision;
  const valid = (record: unknown): record is CharacterRecord => family === 'memories' ? isMemory(record) && record.revision <= bound : isGoal(record) && record.revision <= bound;
  return within(value.records, family === 'memories' ? MEMORY_LIMIT : GOAL_LIMIT, valid) && distinct(value.records.map(record => record.id));
}
export function isRecordReadResult<T extends CharacterRecord>(snapshot: (v: unknown) => v is RecordSnapshot<T>, value: unknown): value is RecordReadResult<T> {
  return shape(value, ['ok', 'snapshot']) && value.ok === true && snapshot(value.snapshot) ||
    shape(value, ['ok', 'error']) && value.ok === false && (value.error === 'unavailable' || value.error === 'not-found');
}
export function isRecordWriteResult<T extends CharacterRecord>(snapshot: (v: unknown) => v is RecordSnapshot<T>, value: unknown, expected: number): value is RecordWriteResult<T> {
  return shape(value, ['ok', 'error']) && value.ok === false && typeof value.error === 'string' && Object.hasOwn(recordErrorStatus, value.error) ||
    shape(value, ['ok', 'snapshot', 'durability']) && value.ok === true && snapshot(value.snapshot) &&
      (value.durability === 'unchanged' ? value.snapshot.revision === expected :
        (value.durability === 'confirmed' || value.durability === 'unconfirmed') && value.snapshot.revision === expected + 1);
}

export function isMemoryHistorySnapshot(value: unknown, scope: MemoryHistoryInput): value is MemoryHistorySnapshot {
  if (!shape(value, ['schemaVersion', 'petID', 'id', 'revision', 'currentRevision', 'history']) || value.schemaVersion !== 1 ||
      value.petID !== scope.petID || value.id !== scope.id || !version(value.revision) || !version(value.currentRevision) || value.currentRevision > value.revision ||
      !within(value.history, identityHistoryLimit, isMemory)) return false;
  const { history, currentRevision } = value;
  return history.every((memory, i) => memory.chatShare === undefined && memory.id === scope.id && memory.revision < currentRevision &&
    (i === 0 || history[i - 1]!.revision < memory.revision));
}
