export const voiceDraftIPC = { select: 'pet:voice-draft-select', cancel: 'pet:voice-draft-cancel' } as const;
export const microphoneIPC = {
  authorize: 'pet:microphone-authorize', arm: 'pet:microphone-arm', started: 'pet:microphone-started',
  finish: 'pet:microphone-finish', cancel: 'pet:microphone-cancel', revoked: 'pet:microphone-revoked',
} as const;
export type VoiceDraftError = 'unavailable' | 'busy' | 'cancelled' | 'invalid-file' | 'timeout' | 'no-speech' | 'failed' |
  'too-short' | 'permission-required' | 'permission-denied';
export type VoiceDraftResult = { ok: true; text: string } | { ok: false; error: VoiceDraftError };
export type MicrophoneStart = { ok: true } | { ok: false; error: VoiceDraftError };
export type VoiceDraftBridge = { select(): Promise<VoiceDraftResult>; cancel(): Promise<void>; microphone: {
  authorize(): Promise<MicrophoneStart>; start(interrupted: () => void): Promise<MicrophoneStart>;
  stop(): Promise<VoiceDraftResult>; cancel(): void;
} };

export function validVoiceDraft(text: unknown): text is string {
  return typeof text === 'string' && text.length > 0 && text.length <= 1000 && text.trim() === text &&
    !/[\p{Cc}\p{Cs}\u2028\u2029]/u.test(text);
}
