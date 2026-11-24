import { isKnowledgeQuery, knowledgeSearchBytes } from './knowledge-search.ts';
import { petId, shape } from './pets.ts';

export type LocalChatIntent = { intent: 'identity' | 'goals' } | { intent: 'knowledge' | 'memory'; query: string };
export type LocalChatInput = LocalChatIntent & { petID: string };
export const localChatRequestBytes = knowledgeSearchBytes;
export const localChatResponseBytes = 16 * 1024;
export const localChatTextLimit = 4000;
export const localChatStatus = { invalid: 400, 'not-found': 404, unavailable: 503 } as const;
export type LocalChatError = keyof typeof localChatStatus;
export type LocalChatResult = { ok: true; petID: string; text: string } | { ok: false; error: LocalChatError };
export interface LocalChatBridge { localChatContext(input: LocalChatInput): Promise<LocalChatResult>; }

/** Recognized commands never fall through to the online adapter, even if invalid. */
export function parseLocalChatCommand(raw: string): LocalChatIntent | 'invalid' | undefined {
  const text = raw.trim();
  if (/^查看本机身份[?？]?$/.test(text)) return { intent: 'identity' };
  if (/^查看目标进度[?？]?$/.test(text)) return { intent: 'goals' };
  const prefix = /^(查角色知识|查个人记忆)\s*[:：]/.exec(text);
  if (!prefix) return;
  const query = text.slice(prefix[0].length).trim();
  if (!isKnowledgeQuery(query)) return 'invalid';
  return { intent: prefix[1] === '查角色知识' ? 'knowledge' : 'memory', query };
}

export function isLocalChatInput(value: unknown): value is LocalChatInput {
  if (shape(value, ['petID', 'intent']) && petId(value.petID) && (value.intent === 'identity' || value.intent === 'goals')) return true;
  return shape(value, ['petID', 'intent', 'query']) && petId(value.petID) &&
    (value.intent === 'knowledge' || value.intent === 'memory') && isKnowledgeQuery(value.query);
}

export function isLocalChatResult(value: unknown, petID: string): value is LocalChatResult {
  return shape(value, ['ok', 'petID', 'text']) && value.ok === true && value.petID === petID && typeof value.text === 'string' &&
    value.text.length <= localChatTextLimit && !!value.text.trim() && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\p{Cs}]/u.test(value.text) ||
    shape(value, ['ok', 'error']) && value.ok === false && typeof value.error === 'string' && Object.hasOwn(localChatStatus, value.error);
}
