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
export const reasoningLabels: Record<ReasoningEffort, string> = {
  none: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高',
};
export const defaultReasoningEffort = (levels: readonly ReasoningEffort[]): ReasoningEffort | undefined =>
  levels.includes('high') ? 'high' : levels[0];
const deepseekModels = ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'];
const deepseekLevels: readonly ReasoningEffort[] = ['none', 'low', 'high', 'max'];
const timiccLevels: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];


export function modelReasoningLevels(identity: ModelIdentity): readonly ReasoningEffort[] {
  const endpoint = identity.baseURL.trim().replace(/\/+$/, '');
  // Match the reference application's explicitly scoped compatibility route, not arbitrary gateways.
  if (identity.protocol === 'responses' && endpoint === 'https://timicc.com/v1' && identity.modelID === 'gpt-6.2-sol') return timiccLevels;
  if (['responses', 'chat-completions'].includes(identity.protocol) && ['https://api.deepseek.com', 'https://api.deepseek.com/v1'].includes(endpoint) && deepseekModels.includes(identity.modelID)) return deepseekLevels;
  if (identity.protocol !== 'responses' || endpoint !== 'https://api.openai.com/v1') return [];
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
