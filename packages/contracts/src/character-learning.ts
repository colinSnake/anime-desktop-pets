import { petId, revision, shape } from './pets.ts';
import { credentialLikeText } from './character-records.ts';
import { isLiveRoleId, type LiveRoleId } from './live-stage.ts';
import { validChatRequestID } from './online-chat.ts';

/** Fixed private management bridge only. Never registered on the OBS listener. */
export const characterLearningPaths = {
  selectChatTurn: '/v1/characters/learning/select-chat-turn', preview: '/v1/characters/learning/preview', generate: '/v1/characters/learning/generate', cancel: '/v1/characters/learning/cancel',
} as const;
export const characterLearningRequestBytes = 512;
export const characterLearningReplyBytes = 16 * 1024;
export const characterLearningTicketMs = 60_000;
export type CharacterLearningTicket = { ticket: string; expiresAt: number };
export type CharacterLearningInput = { petID: string; ticket: string };
export type CharacterLearningGenerateInput = CharacterLearningInput & { confirmation: string; expectedRevision: number; confirmed: true };
export type CharacterLearningChatSelection = { petID: string; sessionID: string; turnID: string };
export type CharacterLearningPreview = CharacterLearningInput & {
  user: string; assistant: string; confirmation: string; revision: number; expiresAt: number;
} & ({ source: 'live'; role: LiveRoleId } | { source: 'chat'; role?: never });
export const characterLearningErrors = ['invalid', 'expired', 'conflict', 'cancelled', 'busy', 'rate-limited', 'duplicate', 'model-unavailable', 'invalid-candidate', 'unavailable', 'write-outcome-unknown'] as const;
export type CharacterLearningErrorCode = typeof characterLearningErrors[number];
export type CharacterLearningFailure = { ok: false; error: CharacterLearningErrorCode };
export type CharacterLearningPreviewResult = { ok: true; preview: CharacterLearningPreview } | CharacterLearningFailure;
export type CharacterLearningGenerateResult = { ok: true; petID: string; candidateID: string; revision: number; durability: 'confirmed' } | CharacterLearningFailure;
export type CharacterLearningCancelResult = { ok: true } | CharacterLearningFailure;
export interface CharacterLearningBridge {
  selectChatTurn(input: CharacterLearningChatSelection): Promise<CharacterLearningPreviewResult>;
  preview(input: CharacterLearningInput): Promise<CharacterLearningPreviewResult>;
  generate(input: CharacterLearningGenerateInput): Promise<CharacterLearningGenerateResult>;
  cancel(input: CharacterLearningInput): Promise<CharacterLearningCancelResult>;
}
export const isCharacterLearningSecret = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{48}$/.test(value);
export const isCharacterLearningInput = (value: unknown): value is CharacterLearningInput =>
  shape(value, ['petID', 'ticket']) && petId(value.petID) && isCharacterLearningSecret(value.ticket);
export const isCharacterLearningChatSelection = (value: unknown): value is CharacterLearningChatSelection =>
  shape(value, ['petID', 'sessionID', 'turnID']) && petId(value.petID) && validChatRequestID(value.sessionID) && validChatRequestID(value.turnID);
export const isCharacterLearningGenerateInput = (value: unknown): value is CharacterLearningGenerateInput =>
  shape(value, ['petID', 'ticket', 'confirmation', 'expectedRevision', 'confirmed']) && petId(value.petID) &&
  isCharacterLearningSecret(value.ticket) && isCharacterLearningSecret(value.confirmation) && revision(value.expectedRevision) && value.confirmed === true;
export const isCharacterLearningText = (value: unknown, limit = 1000): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= limit && value === value.trim() &&
  new TextEncoder().encode(value).byteLength <= limit * 4 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\p{Cs}\u202a-\u202e\u2066-\u2069]/u.test(value) && !credentialLikeText(value);
const failure = (value: unknown): value is CharacterLearningFailure => shape(value, ['ok', 'error']) && value.ok === false &&
  typeof value.error === 'string' && (characterLearningErrors as readonly string[]).includes(value.error);
export const isCharacterLearningPreviewResult = (value: unknown): value is CharacterLearningPreviewResult => {
  if (failure(value)) return true;
  if (!shape(value, ['ok', 'preview']) || value.ok !== true) return false;
  const p = value.preview;
  return shape(p, ['petID', 'ticket', 'source', 'role', 'user', 'assistant', 'confirmation', 'revision', 'expiresAt']) &&
    petId(p.petID) && isCharacterLearningSecret(p.ticket) && (p.source === 'live' ? isLiveRoleId(p.role) : p.source === 'chat' && !Object.hasOwn(p, 'role')) &&
    isCharacterLearningText(p.user) && isCharacterLearningText(p.assistant) && isCharacterLearningSecret(p.confirmation) &&
    revision(p.revision) && typeof p.expiresAt === 'number' && Number.isSafeInteger(p.expiresAt) && p.expiresAt > 0;
};
export const isCharacterLearningGenerateResult = (value: unknown): value is CharacterLearningGenerateResult => failure(value) ||
  (shape(value, ['ok', 'petID', 'candidateID', 'revision', 'durability']) && value.ok === true && petId(value.petID) &&
    typeof value.candidateID === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value.candidateID) && revision(value.revision) && value.durability === 'confirmed');
export const isCharacterLearningCancelResult = (value: unknown): value is CharacterLearningCancelResult => failure(value) ||
  (shape(value, ['ok']) && value.ok === true);
