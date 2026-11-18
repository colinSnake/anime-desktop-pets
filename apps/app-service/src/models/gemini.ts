import { randomUUID } from 'node:crypto';
import { array, call, discoveryPath, invalidResponse, object, recalled, reply, snapshotInput, string, token, usage } from './common.ts';
import type { JsonObject, ProtocolAdapter, ToolCall } from './types.ts';
export const gemini: ProtocolAdapter = {
  encode(route, original) {
    const input = snapshotInput(route, original), contents: Array<{ role: string; parts: JsonObject[] }> = [], omitIDs = new Set<string>(), results = new Map<string, string>();
    let pendingCalls: ToolCall[] = [];
    const push = (role: string, parts: JsonObject[]) => { const previous = contents.at(-1); if (previous?.role === role) previous.parts.push(...parts); else contents.push({ role, parts }); };
    for (const m of input.messages) {
      if (m.role === 'tool') {
        results.set(m.toolCallID, m.text);
        // Calls without native IDs are paired positionally, including same-name parallel calls.
        if (results.size === pendingCalls.length) {
          push('user', pendingCalls.map(c => ({ functionResponse: { ...(omitIDs.has(c.id) ? {} : { id: c.id }), name: c.name, response: { result: results.get(c.id)! } } })));
          pendingCalls = []; results.clear();
        }
      }
      else if (m.role === 'user') push('user', [{ text: m.text }]);
      else {
        pendingCalls = m.toolCalls ?? [];
        const data = recalled(m, route);
        if (Array.isArray(data)) {
          const nativeCalls = data.map(p => object(p)).filter(p => p.functionCall !== undefined).map(p => object(p.functionCall));
          for (const [i, c] of (m.toolCalls ?? []).entries()) if (nativeCalls[i] && nativeCalls[i]!.id === undefined) omitIDs.add(c.id);
        }
        push('model', Array.isArray(data) ? data as JsonObject[] : [...(m.text ? [{ text: m.text }] : []), ...(m.toolCalls ?? []).map(c => ({ functionCall: { id: c.id, name: c.name, args: c.arguments } }))]);
      }
    }
    return { path: `/models/${encodeURIComponent(route.modelID)}:generateContent`, headers: {}, body: { contents, generationConfig: { maxOutputTokens: route.tokenBudget },
      ...(input.system ? { systemInstruction: { parts: [{ text: input.system }] } } : {}), ...(input.tools ? { tools: [{ functionDeclarations: input.tools.map(t => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }] } : {}) } };
  },
  decode(route, raw) {
    const root = object(raw), counts = usage(root.usageMetadata, 'promptTokenCount', 'candidatesTokenCount');
    if (root.promptFeedback !== undefined && object(root.promptFeedback).blockReason) return reply(route, '', [], 'refused', counts);
    const candidates = array(root.candidates, 1); if (candidates.length !== 1) return invalidResponse();
    const candidate = object(candidates[0]), finish = candidate.finishReason;
    if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(String(finish))) return reply(route, '', [], 'refused', counts);
    if (finish !== 'STOP' && finish !== 'MAX_TOKENS') return invalidResponse();
    const content = object(candidate.content); if (content.role !== 'model') return invalidResponse();
    let text = ''; const calls: ToolCall[] = [], replay: JsonObject[] = [];
    for (const v of array(content.parts)) {
      const p = object(v), part: JsonObject = {};
      if (p.thought !== undefined && typeof p.thought !== 'boolean') return invalidResponse();
      if (p.text !== undefined) { const t = string(p.text); if (!p.thought) text += t; part.text = t; if (p.thought) part.thought = true; }
      else if (p.functionCall !== undefined) { const f = object(p.functionCall), c = call(f.id ?? `call-${randomUUID()}`, f.name, f.args ?? {}); calls.push(c); part.functionCall = { ...(f.id === undefined ? {} : { id: c.id }), name: c.name, args: c.arguments }; }
      else return invalidResponse();
      if (p.thoughtSignature !== undefined) part.thoughtSignature = token(p.thoughtSignature, 65_536);
      replay.push(part);
    }
    return reply(route, text, calls, finish === 'MAX_TOKENS' ? 'length' : calls.length ? 'tools' : 'end', counts, replay);
  },
  discovery(cursor) { return { path: discoveryPath('/models', cursor, 'pageToken', 'pageSize=100'), headers: {} }; },
  decodeDiscovery(raw) {
    const root = object(raw), models = array(root.models).flatMap(v => {
      const m = object(v), methods = array(m.supportedGenerationMethods).map(v => string(v, 128));
      if (!methods.includes('generateContent')) return [];
      const name = token(m.name, 263); if (!name.startsWith('models/') || !name.slice(7)) return invalidResponse();
      const result = { modelID: name.slice(7), displayName: token(m.displayName ?? name.slice(7), 256), tools: 'unknown' as const };
      const limits: { contextWindow?: number; maxOutputTokens?: number } = {};
      for (const [field, dest] of [['inputTokenLimit', 'contextWindow'], ['outputTokenLimit', 'maxOutputTokens']] as const) if (m[field] !== undefined) {
        if (!Number.isInteger(m[field]) || Number(m[field]) < 1 || Number(m[field]) > 2_147_483_647) return invalidResponse(); limits[dest] = Number(m[field]);
      }
      return [{ ...result, ...limits }];
    });
    return { models, ...(root.nextPageToken === undefined || root.nextPageToken === '' ? {} : { next: token(root.nextPageToken, 1024) }) };
  },
};
