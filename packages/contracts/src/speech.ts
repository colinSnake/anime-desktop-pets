/** Workspace speech describes only the current session; it cannot submit text for playback. */
export const speechStates = ['unavailable', 'disabled', 'enabled', 'loading', 'speaking', 'failed'] as const;
export type SpeechStatus = { state: typeof speechStates[number]; hasReference: boolean };
export type SpeechResult = { ok: true; speech: SpeechStatus } | { ok: false; error: 'unavailable' | 'invalid' | 'invalid-audio' | 'reference-required' | 'busy' };
export interface SpeechBridge {
  status(): Promise<SpeechResult>;
  selectReference(): Promise<SpeechResult>;
  clearReference(): Promise<SpeechResult>;
  enable(input: { referenceTranscript: string }): Promise<SpeechResult>;
  disable(): Promise<SpeechResult>;
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function isSpeechResult(value: unknown): value is SpeechResult {
  if (!object(value) || Object.keys(value).length !== 2) return false;
  if (value.ok === false) return ['unavailable', 'invalid', 'invalid-audio', 'reference-required', 'busy'].some(error => error === value.error);
  return value.ok === true && object(value.speech) && Object.keys(value.speech).length === 2 &&
    speechStates.some(state => state === (value.speech as Record<string, unknown>).state) && typeof value.speech.hasReference === 'boolean';
}
export function isSpeechEnableInput(input: unknown): input is { referenceTranscript: string } {
  if (!object(input) || Object.keys(input).length !== 1 || typeof input.referenceTranscript !== 'string') return false;
  const text = input.referenceTranscript;
  return text.length <= 4096 && new TextEncoder().encode(text).length <= 4096 && !!text.trim() && !/[\p{Cs}\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(text);
}
