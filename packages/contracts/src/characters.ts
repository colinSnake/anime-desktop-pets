import type { LocalChatBridge } from './local-chat.ts';
import type { KnowledgeSearchBridge } from './knowledge-search.ts';
import type { KnowledgeFileBridge } from './knowledge-import.ts';
import type { CharacterRecordsBridge } from './character-records.ts';
import { petId, revision, shape } from './pets.ts';

export const identityRecordLimit = 1_048_576;
export const identityHistoryLimit = 5;
export const identityFields = ['role', 'background', 'personality', 'values', 'motivations', 'relationship', 'speakingStyle', 'knowledgeScope', 'boundaries'] as const;
export type IdentityDraft = { name: string } & Record<(typeof identityFields)[number], string>;
export type ChatShare = { chatShare?: true };
export type Identity = IdentityDraft & ChatShare & { revision: number; createdAt: string; updatedAt: string };
export type IdentityInput = { petID: string };
export type IdentitySnapshot = { schemaVersion: 1; petID: string; revision: number; identity: Identity | null; identityHistory: Identity[] };
export type IdentityResult = { ok: true; snapshot: IdentitySnapshot } | { ok: false; error: 'not-found' | 'unavailable' };
export interface IdentityBridge {
  readIdentity(input: IdentityInput): Promise<IdentityResult>;
  saveIdentity(input: IdentitySaveInput): Promise<IdentityWriteResult>;
  restoreIdentity(input: IdentityRestoreInput): Promise<IdentityWriteResult>;
  setIdentityChatShare(input: IdentityChatShareInput): Promise<IdentityWriteResult>;
}

export type CharactersBridge = IdentityBridge & CharacterRecordsBridge & KnowledgeFileBridge & KnowledgeSearchBridge & LocalChatBridge;

export function validIdentityInput(value: unknown): value is IdentityInput {
  return shape(value, ['petID']) && petId(value.petID);
}

const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
const count = (value: string): number => { let n = 0; for (const _ of segmenter.segment(value)) n++; return n; };
function text(value: unknown, limit: number, headline = false): value is string {
  return typeof value === 'string' && value.length <= limit * 16 && (!headline || (!!value.trim() && !/[\t\n\u2028\u2029]/u.test(value))) &&
    !/[\p{Cs}\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(value) && count(value) <= limit;
}
const versionFields = ['revision', 'createdAt', 'updatedAt', 'chatShare'];
const iso = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export function isIdentityDraft(value: unknown, extra: readonly string[] = []): value is IdentityDraft {
  return shape(value, ['name', ...identityFields, ...extra]) && text(value.name, 80, true) &&
    identityFields.every(key => text(value[key], 2000)) && identityFields.reduce((n, key) => n + count(value[key] as string), count(value.name)) <= 8000;
}
export function isIdentityRecord(value: unknown): value is Identity {
  return shape(value, ['name', ...identityFields, ...versionFields]) && revision(value.revision) && value.revision > 0 &&
    (value.chatShare === undefined || value.chatShare === true) && iso(value.createdAt) && iso(value.updatedAt) && value.createdAt <= value.updatedAt && isIdentityDraft(value, versionFields);
}
export function isIdentitySnapshot(value: unknown, petID: string): value is IdentitySnapshot {
  if (!shape(value, ['schemaVersion', 'petID', 'revision', 'identity', 'identityHistory']) || value.schemaVersion !== 1 ||
    value.petID !== petID || !revision(value.revision) || !Array.isArray(value.identityHistory) || value.identityHistory.length > identityHistoryLimit) return false;
  const current = value.identity, history = Array.from(value.identityHistory);
  return current === null ? history.length === 0 : isIdentityRecord(current) && current.revision <= value.revision &&
    history.every((record, index) => isIdentityRecord(record) && record.chatShare === undefined && record.revision === current.revision - history.length + index &&
      record.createdAt === current.createdAt && record.updatedAt <= (history[index + 1] ?? current).updatedAt);
}
export function isIdentityResult(value: unknown, petID: string): value is IdentityResult {
  return shape(value, ['ok', 'snapshot']) && value.ok === true && isIdentitySnapshot(value.snapshot, petID) ||
    shape(value, ['ok', 'error']) && value.ok === false && (value.error === 'not-found' || value.error === 'unavailable');
}

export const identityWriteLimit = 256 * 1024;
export const identityWriteActions = ['saveIdentity', 'restoreIdentity', 'setIdentityChatShare'] as const;
export type IdentityWriteAction = typeof identityWriteActions[number];
export type IdentitySaveInput = IdentityInput & { expectedRevision: number; draft: IdentityDraft };
export type IdentityRestoreInput = IdentityInput & { expectedRevision: number; historicalRevision: number };
export type IdentityChatShareInput = IdentityInput & { expectedRevision: number; enabled: boolean };
export const identityWriteErrors = ['not-found', 'unavailable', 'invalid', 'limit', 'conflict', 'busy', 'history-not-found', 'credential-like', 'write-outcome-unknown'] as const;
export type IdentityWriteError = typeof identityWriteErrors[number];
export type IdentityWriteResult =
  | { ok: true; snapshot: IdentitySnapshot; durability: 'confirmed' | 'unchanged' | 'unconfirmed' }
  | { ok: false; error: IdentityWriteError };

export function identityDraftOf(record: Identity): IdentityDraft {
  return { name: record.name, ...Object.fromEntries(identityFields.map(key => [key, record[key]])) } as IdentityDraft;
}
export function isIdentityWriteInput(action: 'saveIdentity', value: unknown): value is IdentitySaveInput;
export function isIdentityWriteInput(action: 'restoreIdentity', value: unknown): value is IdentityRestoreInput;
export function isIdentityWriteInput(action: 'setIdentityChatShare', value: unknown): value is IdentityChatShareInput;
export function isIdentityWriteInput(action: IdentityWriteAction, value: unknown): value is IdentityWriteInput;
export function isIdentityWriteInput(action: IdentityWriteAction, value: unknown): value is IdentityWriteInput {
  if (action === 'setIdentityChatShare') return shape(value, ['petID', 'expectedRevision', 'enabled']) && petId(value.petID) &&
    revision(value.expectedRevision) && typeof value.enabled === 'boolean';
  if (action === 'saveIdentity') return shape(value, ['petID', 'expectedRevision', 'draft']) && petId(value.petID) &&
    revision(value.expectedRevision) && isIdentityDraft(value.draft) &&
    new TextEncoder().encode(JSON.stringify({ expectedRevision: value.expectedRevision, draft: value.draft })).byteLength <= identityWriteLimit;
  return action === 'restoreIdentity' && shape(value, ['petID', 'expectedRevision', 'historicalRevision']) && petId(value.petID) &&
    revision(value.expectedRevision) && revision(value.historicalRevision) && value.historicalRevision > 0;
}
export function isIdentityWriteResult(value: unknown, input: IdentityWriteInput): value is IdentityWriteResult {
  if (shape(value, ['ok', 'error']) && value.ok === false) return identityWriteErrors.some(error => error === value.error);
  return shape(value, ['ok', 'snapshot', 'durability']) && value.ok === true && isIdentitySnapshot(value.snapshot, input.petID) &&
    value.snapshot.identity !== null && (!('enabled' in input) || (value.snapshot.identity.chatShare === true) === input.enabled) && (value.durability === 'unchanged' ? value.snapshot.revision === input.expectedRevision :
      (value.durability === 'confirmed' || value.durability === 'unconfirmed') && value.snapshot.revision === input.expectedRevision + 1);
}
export type IdentityWriteInput = IdentitySaveInput | IdentityRestoreInput | IdentityChatShareInput;
