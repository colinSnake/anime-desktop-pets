import { modelUserText, array, call, discoveryItems, discovered, discoveryPath, invalidResponse, object, recalled, reply, snapshotInput, string, token, usage } from './common.ts';
import type { JsonObject, ProtocolAdapter, ToolCall } from './types.ts';
const headers = { 'anthropic-version': '2023-06-01' };
export const anthropic: ProtocolAdapter = {
  encode(route, original) {
    const input = snapshotInput(route, original), messages: Array<{ role: string; content: JsonObject[] }> = [];
    const push = (role: string, content: JsonObject[]) => { const previous = messages.at(-1); if (previous?.role === role) previous.content.push(...content); else messages.push({ role, content }); };
    for (const m of input.messages) {
      if (m.role === 'tool') push('user', [{ type: 'tool_result', tool_use_id: m.toolCallID, content: m.text }]);
      else if (m.role === 'user') push('user', [{ type: 'text', text: modelUserText(input, m) }]);
      else {
        const data = recalled(m, route);
        push('assistant', Array.isArray(data) ? data as JsonObject[] : [...(m.text ? [{ type: 'text', text: m.text }] : []), ...(m.toolCalls ?? []).map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments }))]);
      }
    }
    return { path: '/messages', headers: { ...headers }, body: { model: route.modelID, messages, max_tokens: route.tokenBudget,
      ...(input.system ? { system: input.system } : {}), ...(input.tools ? { tools: input.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}) } };
  },
  decode(route, raw) {
    const root = object(raw);
    if (root.type !== 'message' || root.role !== 'assistant' || !['end_turn', 'stop_sequence', 'max_tokens', 'tool_use', 'refusal'].includes(String(root.stop_reason))) return invalidResponse();
    let text = ''; const calls: ToolCall[] = [], replay: JsonObject[] = [];
    for (const v of array(root.content)) {
      const p = object(v);
      if (p.type === 'text') { const t = string(p.text); text += t; replay.push({ type: 'text', text: t }); }
      else if (p.type === 'tool_use') { const c = call(p.id, p.name, p.input); calls.push(c); replay.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments }); }
      else if (p.type === 'thinking') replay.push({ type: 'thinking', thinking: string(p.thinking), signature: token(p.signature, 65_536) });
      else if (p.type === 'redacted_thinking') replay.push({ type: 'redacted_thinking', data: token(p.data, 65_536) });
      else return invalidResponse();
    }
    return reply(route, text, calls, root.stop_reason === 'max_tokens' ? 'length' : root.stop_reason === 'refusal' ? 'refused' : root.stop_reason === 'tool_use' ? 'tools' : 'end', usage(root.usage, 'input_tokens', 'output_tokens'), replay);
  },
  discovery(cursor) { return { path: discoveryPath('/models', cursor, 'after_id', 'limit=100'), headers: { ...headers } }; },
  decodeDiscovery(raw, firstPage) { const root = object(raw), { items, truncated } = discoveryItems(root.data, firstPage);
    if (root.has_more !== undefined && typeof root.has_more !== 'boolean') return invalidResponse();
    return { models: items.map(v => discovered(v, 'id', 'display_name')), ...(truncated ? { truncated: true } : {}), ...(root.has_more === true ? { next: token(root.last_id, 1024) } : {}) }; },
};
