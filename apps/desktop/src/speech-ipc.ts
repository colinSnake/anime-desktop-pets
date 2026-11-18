import { isSpeechEnableInput } from '../../../packages/contracts/src/speech.ts';
export const speechMethods = ['status', 'selectReference', 'clearReference', 'enable', 'disable'] as const;
export type SpeechMethod = typeof speechMethods[number];
export function validSpeechArgs(method: SpeechMethod, args: unknown[]) {
  return method === 'enable' ? args.length === 1 && isSpeechEnableInput(args[0]) : args.length === 0;
}
