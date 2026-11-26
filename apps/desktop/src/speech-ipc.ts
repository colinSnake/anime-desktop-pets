import { isSpeechEnableInput, isSpeechTranscriptInput } from '../../../packages/contracts/src/speech.ts';
export const speechMethods = ['preview', 'stopPreview', 'status', 'selectReference', 'clearReference', 'saveTranscript', 'enable', 'disable'] as const;
export type SpeechMethod = typeof speechMethods[number];
export function validSpeechArgs(method: SpeechMethod, args: unknown[]) {
  if (method === 'enable') return args.length === 1 && isSpeechEnableInput(args[0]);
  if (method === 'saveTranscript') return args.length === 1 && isSpeechTranscriptInput(args[0]);
  return args.length === 0;
}
