import { argumentsObject, array, call, discovered, invalidResponse, object, recalled, reply, snapshotInput, string, token, usage } from './common.ts';
import type { JsonObject, ProtocolAdapter, ToolCall } from './types.ts';
export const responses: ProtocolAdapter = {
  encode(route, original) {
    const input = snapshotInput(route, original), items: JsonObject[] = [];
    for (const m of input.messages) {
      if (m.role === 'tool') items.push({ type: 'function_call_output', call_id: m.toolCallID, output: m.text });
      else if (m.role === 'user') items.push({ role: 'user', content: [{ type: 'input_text', text: m.text }] });
      else {
        const data = recalled(m, route);
        if (Array.isArray(data)) items.push(...data as JsonObject[]);
        else {
          if (m.text) items.push({ role: 'assistant', content: m.text });
          for (const c of m.toolCalls ?? []) items.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.arguments) });
        }
      }
    }
    return { path: '/responses', headers: {}, body: { model: route.modelID, input: items, store: false, include: ['reasoning.encrypted_content'], max_output_tokens: route.tokenBudget,
      ...(input.system ? { instructions: input.system } : {}), ...(input.tools ? { tools: input.tools.map(t => ({ type: 'function', ...t, strict: false })) } : {}) } };
  },
  decode(route, raw) {
    const root = object(raw);
    const incomplete = root.status === 'incomplete' ? object(root.incomplete_details).reason : undefined;
    if (root.status !== 'completed' && !(root.status === 'incomplete' && (incomplete === 'max_output_tokens' || incomplete === 'content_filter'))) return invalidResponse();
    let text = '', refused = incomplete === 'content_filter';
    const calls: ToolCall[] = [], replay: JsonObject[] = [];
    for (const v of array(root.output)) {
      const item = object(v);
      if (item.type === 'reasoning') {
        // Native item IDs and reasoning stay private and bound to this exact route.
        const summary = array(item.summary).map(v => { const part = object(v); if (part.type !== 'summary_text') return invalidResponse(); return { type: 'summary_text', text: string(part.text) }; });
        if (item.encrypted_content != null) replay.push({ type: 'reasoning', id: token(item.id), summary, encrypted_content: string(item.encrypted_content) });
      } else if (item.type === 'function_call') {
        const c = call(item.call_id, item.name, argumentsObject(item.arguments)); calls.push(c);
        replay.push({ type: 'function_call', ...(item.id === undefined ? {} : { id: token(item.id) }), call_id: c.id, name: c.name, arguments: JSON.stringify(c.arguments) });
      } else if (item.type === 'message' && item.role === 'assistant') {
        const content: JsonObject[] = [];
        for (const v of array(item.content)) {
          const part = object(v);
          if (part.type === 'output_text') { const t = string(part.text); text += t; content.push({ type: 'output_text', text: t, annotations: [] }); }
          else if (part.type === 'refusal') { refused = true; const t = string(part.refusal); text += t; content.push({ type: 'refusal', refusal: t }); }
          else return invalidResponse();
        }
        if (item.phase !== undefined && item.phase !== null && item.phase !== 'commentary' && item.phase !== 'final_answer') return invalidResponse();
        if (item.id === undefined) replay.push({ role: 'assistant', content: content.map(p => p.text ?? p.refusal).join('') });
        else replay.push({ type: 'message', id: token(item.id), status: root.status === 'completed' ? 'completed' : 'incomplete', role: 'assistant', content, ...(item.phase == null ? {} : { phase: item.phase as string }) });
      } else return invalidResponse();
    }
    return reply(route, text, calls, refused ? 'refused' : root.status === 'incomplete' ? 'length' : calls.length ? 'tools' : 'end', usage(root.usage, 'input_tokens', 'output_tokens'), replay);
  },
  discovery() { return { path: '/models', headers: {} }; },
  decodeDiscovery(raw) { const root = object(raw); return { models: array(root.data).map(v => discovered(v)), ...(root.has_more === true ? { truncated: true } : {}) }; },
};
