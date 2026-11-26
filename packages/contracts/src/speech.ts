/** Workspace speech exposes local settings and session state, no arbitrary playback. */
export const speechStates = ['unavailable', 'disabled', 'enabled', 'loading', 'speaking', 'failed'] as const;
const speechRuntimeStates = ['cold', 'preparing', 'ready', 'failed'] as const;
export type SpeechRuntimeReadiness = typeof speechRuntimeStates[number];
export type SpeechStatus = {
  state: typeof speechStates[number]; hasReference: boolean; referenceTranscript?: string;
  runtime?: SpeechRuntimeReadiness; previewing?: true; previewAvailable?: true; storageUnavailable?: true;
};
export type SpeechEnableInput = { referenceTranscript: string };
export type SpeechTranscriptInput = { referenceTranscript: string };
export const speechPreviewPhrase = '你好，我是桌边小崽。这是本机语音试听，不会发送在线请求。';
export type SpeechPreviewCommand = { revision: number; play: boolean };
export type SpeechResult = { ok: true; speech: SpeechStatus } | { ok: false; error: 'unavailable' | 'invalid' | 'invalid-audio' | 'reference-required' | 'busy' | 'storage' };
export interface SpeechBridge {
  preview(): Promise<SpeechResult>;
  stopPreview(): Promise<SpeechResult>;
  status(): Promise<SpeechResult>;
  selectReference(): Promise<SpeechResult>;
  clearReference(): Promise<SpeechResult>;
  saveTranscript(input: SpeechTranscriptInput): Promise<SpeechResult>;
  enable(input: SpeechEnableInput): Promise<SpeechResult>;
  disable(): Promise<SpeechResult>;
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function isSpeechResult(value: unknown): value is SpeechResult {
  if (!object(value) || Object.keys(value).length !== 2) return false;
  if (value.ok === false) return ['unavailable', 'invalid', 'invalid-audio', 'reference-required', 'busy', 'storage'].some(error => error === value.error);
  return value.ok === true && object(value.speech) && Object.keys(value.speech).every(key => ['state', 'hasReference', 'runtime', 'previewing', 'previewAvailable', 'storageUnavailable', 'referenceTranscript'].includes(key)) &&
    (!Object.hasOwn(value.speech, 'runtime') || value.speech.hasReference === true &&
      (value.speech.state === 'enabled' || value.speech.state === 'loading' || value.speech.state === 'speaking') &&
      speechRuntimeStates.some(runtime => runtime === (value.speech as Record<string, unknown>).runtime)) &&
    (!Object.hasOwn(value.speech, 'previewing') || value.speech.previewing === true) &&
    (!Object.hasOwn(value.speech, 'previewAvailable') || value.speech.previewAvailable === true) &&
    (!Object.hasOwn(value.speech, 'storageUnavailable') || value.speech.storageUnavailable === true && value.speech.state === 'unavailable') &&
    (!Object.hasOwn(value.speech, 'referenceTranscript') || value.speech.hasReference === true && isSpeechTranscriptInput({ referenceTranscript: value.speech.referenceTranscript })) &&
    speechStates.some(state => state === (value.speech as Record<string, unknown>).state) && typeof value.speech.hasReference === 'boolean';
}
export function isSpeechEnableInput(input: unknown): input is SpeechEnableInput {
  if (!object(input) || Object.keys(input).some(key => key !== 'referenceTranscript') || typeof input.referenceTranscript !== 'string') return false;
  const text = input.referenceTranscript;
  return text.length <= 4096 && new TextEncoder().encode(text).length <= 4096 && !!text.trim() && !/[\p{Cs}\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(text);
}

export function isSpeechTranscriptInput(input: unknown): input is SpeechTranscriptInput {
  if (!object(input) || Object.keys(input).some(key => key !== 'referenceTranscript') || typeof input.referenceTranscript !== 'string') return false;
  const text = input.referenceTranscript;
  return text.length <= 4096 && new TextEncoder().encode(text).length <= 4096 && !/[\p{Cs}\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(text);
}
