import { isChatMemoryCommand } from './character-records.ts';
import { parseLocalChatCommand } from './local-chat.ts';
import { petId, shape } from './pets.ts';
import { chatRequestWithAttachmentsBytes, validateChatAttachments, type ChatAttachment } from './chat-attachments.ts';
import type { InputModality } from './models.ts';

export const chatPaths = { list: '/v1/chat/models', send: '/v1/chat/send' } as const;
export const chatIPC = { list: 'pet:chat-models', send: 'pet:chat-send', cancel: 'pet:chat-cancel' } as const;
export const chatRequestBytes = 64 * 1024;
export const chatListBytes = 1_250 * 1024;
export const chatReplyBytes = 50 * 1024;
export type ChatRoute = { connectionID: string; modelEntryID: string; fingerprint: string; useDefault?: true };
export type ChatOption = { route: Omit<ChatRoute, 'useDefault'>; connectionName: string; modelName: string; ready: boolean; isDefault: boolean; inputModalities?: InputModality[]; taskTools?: true | 'unverified' };
export type ChatExchange = { user: string; assistant: string };
export type ChatConversation = { id: string; mode: 'new' | 'resume' };
export type OnlineChatInput = { requestID: string; petID: string; route: ChatRoute; text: string; history: ChatExchange[]; conversation?: ChatConversation; turnID?: string; attachments?: ChatAttachment[] };
export const chatStatus = {
  invalid_request: 400, not_found: 404, conversation_missing: 409, route_changed: 409, context_changed: 409, not_configured: 409, credentials_unavailable: 409,
  cancelled: 409, busy: 409, authentication_failed: 502, rate_limited: 429, invalid_response: 502, upstream_unavailable: 502,
  timed_out: 504, unavailable: 503,
} as const;
export type ChatErrorCode = keyof typeof chatStatus;
export type ChatError = { ok: false; error: ChatErrorCode };
export type ChatListResult = { ok: true; models: ChatOption[]; persistentConversations?: true } | ChatError;
export type ChatSendResult = { ok: true; requestID: string; text: string; replayable: boolean; recovered?: true; historyStatus?: 'unconfirmed' | 'omitted' } | ChatError;
export interface OnlineChatBridge {
  list(): Promise<ChatListResult>;
  send(input: OnlineChatInput): Promise<ChatSendResult>;
  cancel(requestID: string): Promise<void>;
}
const encoder = new TextEncoder();
const size = (value: string) => encoder.encode(value).length;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const fingerprint = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safeText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max &&
  !!value.trim() && size(value) <= max && !/[\p{Cs}\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(value);
const label = (value: unknown): value is string => safeText(value, 128) && !/[\x00-\x1f]/.test(value);
const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
export const onlineCharacterCount = (value: string) => [...segmenter.segment(value)].length;
export const acceptedChatText = (value: unknown): value is string => safeText(value, 12 * 1024) && onlineCharacterCount(value) <= 1200 && !parseLocalChatCommand(value) && !isChatMemoryCommand(value);
export const validChatRequestID = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export const isChatConversation = (value: unknown): value is ChatConversation => shape(value, ['id', 'mode']) && validChatRequestID(value.id) && (value.mode === 'new' || value.mode === 'resume');
export const validChatReplyText = (value: unknown): value is string => safeText(value, 24 * 1024);
export const sameChatRoute = (a: ChatRoute, b: ChatRoute): boolean => a.connectionID === b.connectionID && a.modelEntryID === b.modelEntryID && a.fingerprint === b.fingerprint;
export function validRoute(value: unknown, allowDefault: boolean): value is ChatRoute {
  return shape(value, allowDefault ? ['connectionID', 'modelEntryID', 'fingerprint', 'useDefault'] : ['connectionID', 'modelEntryID', 'fingerprint']) &&
    identifier(value.connectionID) && identifier(value.modelEntryID) && fingerprint(value.fingerprint) && (value.useDefault === undefined || value.useDefault === true);
}
export function validOnlineChatInput(value: unknown): value is OnlineChatInput {
  if (!shape(value, ['requestID', 'petID', 'route', 'text', 'history', 'conversation', 'turnID', 'attachments']) ||
      !validChatRequestID(value.requestID) || !petId(value.petID) || !validRoute(value.route, true) || !acceptedChatText(value.text) || !Array.isArray(value.history) || value.history.length > 5 ||
      (value.conversation !== undefined && !(isChatConversation(value.conversation) && value.history.length === 0)) ||
      (value.turnID !== undefined && !(value.conversation !== undefined && validChatRequestID(value.turnID))) ||
      !value.history.every(item => shape(item, ['user', 'assistant']) && acceptedChatText(item.user) && safeText(item.assistant, 12 * 1024))) return false;
  const attachments = validateChatAttachments(value.attachments, value.text);
  if (!attachments.ok) return false;
  const encoded = JSON.stringify(value);
  return size(encoded) <= (attachments.attachments.length ? chatRequestWithAttachmentsBytes : chatRequestBytes) &&
    value.history.reduce((count, pair) => count + onlineCharacterCount(pair.user) + onlineCharacterCount(pair.assistant), onlineCharacterCount(value.text)) <= 6000;
}
const isError = (value: unknown): value is ChatError => shape(value, ['ok', 'error']) && value.ok === false && typeof value.error === 'string' && Object.hasOwn(chatStatus, value.error);
export function isChatListResult(value: unknown): value is ChatListResult {
  if (isError(value)) return true;
  if (!shape(value, ['ok', 'models', 'persistentConversations']) || value.ok !== true || (value.persistentConversations !== undefined && value.persistentConversations !== true) || !Array.isArray(value.models) || value.models.length > 32 * 33) return false;
  let defaults = 0;
  const seen = new Set<string>();
  return value.models.every(item => {
    if (!shape(item, ['route', 'connectionName', 'modelName', 'ready', 'isDefault', 'inputModalities', 'taskTools']) || !validRoute(item.route, false) || !label(item.connectionName) ||
        !label(item.modelName) || typeof item.ready !== 'boolean' || typeof item.isDefault !== 'boolean' || item.isDefault && ++defaults > 1 ||
        item.taskTools !== undefined && item.taskTools !== true && item.taskTools !== 'unverified' || item.inputModalities !== undefined && (!Array.isArray(item.inputModalities) || item.inputModalities.length > 2 ||
          item.inputModalities.some(value => value !== 'image' && value !== 'pdf') || new Set(item.inputModalities).size !== item.inputModalities.length ||
          item.inputModalities.includes('pdf') && !item.inputModalities.includes('image'))) return false;
    const id = `${item.route.connectionID}/${item.route.modelEntryID}`;
    if (seen.has(id)) return false;
    seen.add(id); return true;
  });
}
export function isChatSendResult(value: unknown, requestID: string): value is ChatSendResult {
  return isError(value) || shape(value, ['ok', 'requestID', 'text', 'replayable', 'historyStatus', 'recovered']) && value.ok === true && value.requestID === requestID &&
    validChatReplyText(value.text) && typeof value.replayable === 'boolean' &&
    (value.recovered === undefined || value.recovered === true && value.historyStatus === undefined) &&
    (value.historyStatus === undefined || value.historyStatus === 'unconfirmed' || value.historyStatus === 'omitted');
}
