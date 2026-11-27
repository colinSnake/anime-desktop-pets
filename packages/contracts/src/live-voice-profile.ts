import { isLiveRoleId, type LiveRoleId } from './live-stage.ts';
import { petId } from './pets.ts';
import { isSpeechTranscriptInput } from './speech.ts';

/** Renderer-safe intent. Paths and reference bytes are deliberately not part of this contract. */
export type LiveVoiceProfileTarget = { role: LiveRoleId; petID: string; bindingRevision: number };
export type LiveVoiceProfileMutation = LiveVoiceProfileTarget & { expectedRevision: number };
export type LiveVoiceTranscriptInput = LiveVoiceProfileMutation & { referenceTranscript: string };
export type LiveVoiceProfileSnapshot = LiveVoiceProfileTarget & {
  revision: number; hasReference: boolean; referenceTranscript: string; ready: boolean;
};
export type LiveVoiceProfileError = 'invalid' | 'conflict' | 'unbound' | 'cancelled' | 'reference-required' | 'storage' | 'unavailable';
export type LiveVoiceProfileResult = { ok: true; profile: LiveVoiceProfileSnapshot } | { ok: false; error: LiveVoiceProfileError };
const targetKeys = ['role', 'petID', 'bindingRevision'];
const mutationKeys = [...targetKeys, 'expectedRevision'];
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
const revision = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
function target(value: Record<string, unknown>): boolean {
  return isLiveRoleId(value.role) && petId(value.petID) && revision(value.bindingRevision);
}
export function isLiveVoiceProfileTarget(value: unknown): value is LiveVoiceProfileTarget {
  return exact(value, targetKeys) && target(value);
}
export function isLiveVoiceProfileMutation(value: unknown): value is LiveVoiceProfileMutation {
  return exact(value, mutationKeys) && target(value) && revision(value.expectedRevision);
}
export function isLiveVoiceTranscriptInput(value: unknown): value is LiveVoiceTranscriptInput {
  return exact(value, [...mutationKeys, 'referenceTranscript']) && target(value) && revision(value.expectedRevision) && isSpeechTranscriptInput({ referenceTranscript: value.referenceTranscript });
}
export function isLiveVoiceProfileResult(value: unknown): value is LiveVoiceProfileResult {
  if (exact(value, ['ok', 'error']) && value.ok === false)
    return typeof value.error === 'string' && ['invalid', 'conflict', 'unbound', 'cancelled', 'reference-required', 'storage', 'unavailable'].includes(value.error);
  if (!exact(value, ['ok', 'profile']) || value.ok !== true || !exact(value.profile, [...targetKeys, 'revision', 'hasReference', 'referenceTranscript', 'ready'])) return false;
  const row = value.profile;
  return target(row) && revision(row.revision) && typeof row.hasReference === 'boolean' && typeof row.ready === 'boolean' &&
    isSpeechTranscriptInput({ referenceTranscript: row.referenceTranscript }) &&
    (row.hasReference || row.referenceTranscript === '') && row.ready === (row.hasReference && !!(row.referenceTranscript as string).trim());
}
