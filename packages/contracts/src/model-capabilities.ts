import type { ModelProtocol } from './models.ts';

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];
export const INPUT_MODALITIES = ['image', 'pdf'] as const;
export type InputModality = typeof INPUT_MODALITIES[number];

type ModelIdentity = { protocol: ModelProtocol; baseURL: string; modelID: string };
type ModelCapabilities = ModelIdentity & {
  reasoningEffort?: ReasoningEffort;
  inputModalities?: InputModality[];
};

const reasoningRules: Readonly<Record<string, readonly ReasoningEffort[]>> = Object.freeze({
  'gpt-6.2-astra': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-6.2-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-6.1-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
});
const reasoningEndpoint = 'https://api.openai.com/v1';

export function modelReasoningLevels(identity: ModelIdentity): readonly ReasoningEffort[] {
  const endpoint = identity.baseURL.trim().replace(/\/+$/, '');
  if (identity.protocol !== 'responses' || endpoint !== reasoningEndpoint) return [];
  return Object.hasOwn(reasoningRules, identity.modelID) ? reasoningRules[identity.modelID]! : [];
}

export function validModelCapabilities(value: ModelCapabilities): boolean {
  const { reasoningEffort, inputModalities, protocol } = value;
  if (reasoningEffort !== undefined && !modelReasoningLevels(value).includes(reasoningEffort)) return false;
  if (inputModalities === undefined) return true;
  if (protocol !== 'responses' || !Array.isArray(inputModalities) || inputModalities.length > INPUT_MODALITIES.length ||
      inputModalities.some(modality => !INPUT_MODALITIES.includes(modality)) || new Set(inputModalities).size !== inputModalities.length) return false;
  return !inputModalities.includes('pdf') || inputModalities.includes('image');
}
