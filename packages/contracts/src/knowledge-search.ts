import { credentialLike, distinct, normalizeMemoryText, recordID, within, type Memory } from './character-records.ts';
import { petId, revision, shape } from './pets.ts';

export const knowledgeQueryLimit = 120;
export const knowledgeMatchLimit = 3;
export const knowledgeSearchBytes = 2 * 1024;
export type KnowledgeSearchInput = { petID: string; expectedRevision: number; query: string };
export const knowledgeSearchStatus = { invalid: 400, 'not-found': 404, conflict: 409, unavailable: 503 } as const;
export type KnowledgeSearchError = keyof typeof knowledgeSearchStatus;
export type KnowledgeSearchResult = { ok: true; petID: string; revision: number; ids: string[] } | { ok: false; error: KnowledgeSearchError };
export interface KnowledgeSearchBridge { searchKnowledge(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult>; }

export function isKnowledgeQuery(value: unknown): value is string {
  return typeof value === 'string' && value.length <= knowledgeQueryLimit &&
    !/[\p{Cc}\p{Cs}\u2028\u2029]/u.test(value) && Array.from(normalizeMemoryText(value)).length >= 2 &&
    !credentialLike({ kind: '知识', text: value, source: '', citation: '', version: '' });
}
export function isKnowledgeSearchInput(value: unknown): value is KnowledgeSearchInput {
  return shape(value, ['petID', 'expectedRevision', 'query']) && petId(value.petID) && revision(value.expectedRevision) && isKnowledgeQuery(value.query);
}
export function isKnowledgeSearchResult(value: unknown, input: KnowledgeSearchInput): value is KnowledgeSearchResult {
  return shape(value, ['ok', 'petID', 'revision', 'ids']) && value.ok === true && value.petID === input.petID && value.revision === input.expectedRevision &&
    within(value.ids, knowledgeMatchLimit, recordID) && distinct(value.ids) ||
    shape(value, ['ok', 'error']) && value.ok === false && typeof value.error === 'string' && Object.hasOwn(knowledgeSearchStatus, value.error);
}
export function usableKnowledge(memory: Memory, now: string) {
  return memory.kind === '知识' && memory.status === 'confirmed' && (!memory.expiresAt || memory.expiresAt > now) && !credentialLike(memory);
}
