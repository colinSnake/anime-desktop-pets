import { ModelError } from './errors.ts';
import type { JsonObject, JsonValue, ModelInput, ModelMessage, ModelReply, ModelRoute, ToolCall } from './types.ts';
import { validateChatAttachments, type ChatAttachment, type ValidatedChatAttachment } from '../../../../packages/contracts/src/chat-attachments.ts';

export const invalidResponse = (): never => { throw new ModelError('invalid_response'); };
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidResponse();
  return value as Record<string, unknown>;
}
export function array(value: unknown, max = 256): unknown[] {
  if (!Array.isArray(value) || value.length > max) return invalidResponse();
  return value;
}
export function string(value: unknown, max = 1_048_576): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > max) return invalidResponse();
  return value;
}
export function token(value: unknown, max = 256): string {
  const s = string(value, max);
  if (!s.trim() || /[\u0000-\u001f\u007f]/.test(s)) return invalidResponse();
  return s;
}
export function jsonObject(value: unknown): JsonObject {
  object(value);
  const walk = (v: unknown, depth: number): void => {
    if (depth > 16) return invalidResponse();
    if (v === null || typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) return;
    if (Array.isArray(v)) { for (const x of array(v, 1024)) walk(x, depth + 1); return; }
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      if (Object.keys(v).length > 256) return invalidResponse();
      for (const [k, x] of Object.entries(v)) {
        if (['__proto__', 'constructor', 'prototype'].includes(k)) return invalidResponse();
        walk(x, depth + 1);
      }
      return;
    }
    return invalidResponse();
  };
  walk(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > 65_536) return invalidResponse();
  return structuredClone(value) as JsonObject;
}
export function argumentsObject(value: unknown): JsonObject {
  try { return jsonObject(JSON.parse(string(value, 65_536))); } catch { return invalidResponse(); }
}
export function usage(raw: unknown, input: string, output: string): ModelReply['usage'] {
  if (raw === undefined) return {};
  const value = object(raw), result: ModelReply['usage'] = {};
  for (const [key, field] of [[input, 'inputTokens'], [output, 'outputTokens']] as const) {
    if (value[key] === undefined) continue;
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0) return invalidResponse();
    result[field] = Number(value[key]);
  }
  return result;
}
export function call(id: unknown, name: unknown, args: unknown): ToolCall {
  const toolName = token(name, 64);
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(toolName)) return invalidResponse();
  return { id: token(id, 256), name: toolName, arguments: jsonObject(args) };
}
const native = new WeakMap<ModelMessage, { origin: string; canonical: string; value: JsonValue }>();
const origin = (r: ModelRoute) => JSON.stringify([r.fingerprint, r.connectionID, r.modelEntryID, r.modelID, r.apiProtocol, r.baseURL, r.authMode, r.credentialRef]);
export function remember(message: ModelMessage, route: ModelRoute, value: JsonValue): void {
  native.set(message, { origin: origin(route), canonical: JSON.stringify(message), value: structuredClone(value) });
}
export function recalled(message: ModelMessage, route: ModelRoute): JsonValue | undefined {
  const stored = native.get(message);
  return stored?.origin === origin(route) && stored.canonical === JSON.stringify(message) ? structuredClone(stored.value) : undefined;
}
const allowsTools = (route: ModelRoute) => route.tools === 'supported' || (route.purpose === 'agent-task' && route.tools === 'unknown');

export function reply(route: ModelRoute, text: string, calls: ToolCall[], stop: ModelReply['stop'], counts: ModelReply['usage'], metadata?: JsonValue): ModelReply {
  if (calls.length > 16 || new Set(calls.map(c => c.id)).size !== calls.length || (!text.trim() && !calls.length && stop !== 'refused' && stop !== 'length')) return invalidResponse();
  if (calls.length && !allowsTools(route)) throw new ModelError('tools_unavailable');
  if ((stop === 'tools') !== (calls.length > 0) && stop !== 'length') return invalidResponse();
  const message: ModelReply['message'] = { role: 'assistant', text, ...(calls.length ? { toolCalls: calls } : {}) };
  if (metadata !== undefined) remember(message, route, metadata);
  return { message, stop, usage: counts };
}
/** Copy public input and its private, immutable-origin replay association before any await. */
export function snapshotInput(route: ModelRoute, input: ModelInput): ModelInput {
  try {
    const top = object(input);
    if (Object.keys(top).some(k => !['system', 'messages', 'tools', 'referenceData'].includes(k))) throw 0;
    const messages = array(input.messages, 12);
    if (!messages.length || (input.system !== undefined && string(input.system, 16_384).length === 0)) throw 0;
    const referenceData = input.referenceData === undefined ? undefined : jsonObject(input.referenceData);
    if (referenceData && (route.purpose !== 'text-chat' || Buffer.byteLength(JSON.stringify(referenceData)) > 6144 || object(messages.at(-1)).role !== 'user')) throw 0;
    const tools = input.tools === undefined ? [] : array(input.tools, 16).map(value => {
      const tool = object(value);
      if (Object.keys(tool).some(k => !['name', 'description', 'parameters'].includes(k))) throw 0;
      const name = token(tool.name, 64);
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) throw 0;
      return { name, description: string(tool.description, 4096), parameters: jsonObject(tool.parameters) };
    });
    if (new Set(tools.map(t => t.name)).size !== tools.length) throw 0;
    const names = new Set(tools.map(t => t.name)), pending = new Map<string, string>(), seen = new Set<string>();
    let chars = 0;
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const cloned = messages.map((value, index) => {
      const m = object(value);
      if (!['user', 'assistant', 'tool'].includes(String(m.role)) || Object.keys(m).some(k => !['role', 'text', ...(m.role === 'assistant' ? ['toolCalls'] : m.role === 'tool' ? ['toolCallID'] : m.role === 'user' ? ['attachments'] : [])].includes(k))) throw 0;
      const text = string(m.text, 65_536), count = [...segmenter.segment(text)].length;
      chars += count;
      if ((m.role === 'user' && count > 1200) || chars > 6000) throw 0;
      if (m.role === 'tool') {
        if (!pending.has(String(m.toolCallID))) throw 0;
        pending.delete(String(m.toolCallID));
      } else {
        if (pending.size) throw 0;
        if (m.role === 'assistant' && m.toolCalls !== undefined) {
          for (const value of array(m.toolCalls, 16)) {
            const c = object(value), parsed = call(c.id, c.name, c.arguments);
            if (Object.keys(c).some(k => !['id', 'name', 'arguments'].includes(k)) || !names.has(parsed.name) || seen.has(parsed.id)) throw 0;
            seen.add(parsed.id); pending.set(parsed.id, parsed.name);
          }
        }
      }
      if (!text.trim() && !(m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length)) throw 0;
      let attachments: ValidatedChatAttachment[] = [];
      if (m.attachments !== undefined) {
        if (m.role !== 'user' || index !== messages.length - 1 || route.purpose !== 'text-chat' || !Array.isArray(m.attachments)) throw 0;
        const dto = m.attachments.map(item => {
          const file = object(item);
          if (Object.keys(file).some(key => !['name', 'mediaType', 'data', 'bytes', 'text'].includes(key))) throw 0;
          return { name: file.name, mediaType: file.mediaType, data: file.data } as ChatAttachment;
        });
        const validated = validateChatAttachments(dto, text);
        if (!validated.ok || validated.attachments.some(file => file.mediaType !== 'text/plain' &&
            (route.apiProtocol !== 'responses' || !route.inputModalities?.includes(file.mediaType === 'application/pdf' ? 'pdf' : 'image')))) throw 0;
        attachments = validated.attachments;
      }
      const copy = structuredClone({ ...m, ...(m.attachments === undefined ? {} : { attachments }) }) as ModelMessage;
      const data = recalled(value as ModelMessage, route);
      if (data !== undefined) remember(copy, route, data);
      return copy;
    });
    if (pending.size) throw 0;
    if ((tools.length || cloned.some(m => m.role === 'assistant' && m.toolCalls?.length)) && !allowsTools(route)) throw new ModelError('tools_unavailable');
    return { messages: cloned, ...(input.system === undefined ? {} : { system: input.system }), ...(tools.length ? { tools } : {}), ...(referenceData ? { referenceData } : {}) };
  } catch (error) {
    if (error instanceof ModelError && error.code === 'tools_unavailable') throw error;
    throw new ModelError('invalid_request');
  }
}
/** Keep untrusted reference data at user priority in all protocol adapters. */
export function modelUserText(input: ModelInput, message: ModelMessage, includeTextAttachments = true): string {
  const question = input.referenceData && input.messages.at(-1) === message
    ? JSON.stringify({ question: message.text, characterContext: input.referenceData }) : message.text;
  if (!includeTextAttachments || message.role !== 'user' || !message.attachments?.length) return question;
  return [question, ...message.attachments.filter(file => file.mediaType === 'text/plain').map(file => `${file.name}\n${file.text ?? ''}`)].join('\n\n');
}
export function discoveryPath(base: string, cursor: string | undefined, key: string, first: string): string {
  const params = new URLSearchParams(first);
  if (cursor !== undefined) params.set(key, token(cursor, 1024));
  return `${base}?${params}`;
}
/** Public first-page callers may safely truncate the already byte-bounded payload. */
export function discoveryItems(value: unknown, firstPage = false): { items: unknown[]; truncated: boolean } {
  if (!firstPage) return { items: array(value), truncated: false };
  if (!Array.isArray(value)) return invalidResponse();
  return { items: value.slice(0, 256), truncated: value.length > 256 };
}
export function discovered(value: unknown, label = 'id', name = 'id') {
  const m = object(value), id = token(m[label], 256);
  return { modelID: id, displayName: token(m[name] ?? id, 256), tools: 'unknown' as const };
}
