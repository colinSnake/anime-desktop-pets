import { modelUserText, argumentsObject, array, call, discoveryItems, discovered, invalidResponse, object, recalled, reply, snapshotInput, string, usage } from './common.ts';
import type { JsonObject, ProtocolAdapter } from './types.ts';
export const chatCompletions: ProtocolAdapter = {
  encode(route, original) {
    const input = snapshotInput(route, original);
    const messages: JsonObject[] = input.system ? [{ role: 'system', content: input.system }] : [];
    for (const m of input.messages) {
      if (m.role === 'tool') messages.push({ role: 'tool', tool_call_id: m.toolCallID, content: m.text });
      else if (m.role === 'user') messages.push({ role: 'user', content: modelUserText(input, m) });
      else {
        const data = recalled(m, route);
        messages.push({ role: 'assistant', content: m.text || null,
          ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}),
          ...(typeof data === 'string' ? { reasoning_content: data } : {}) });
      }
    }
    return { path: '/chat/completions', headers: {}, body: { model: route.modelID, messages, [route.compatibility.outputTokenField ?? 'max_completion_tokens']: route.tokenBudget,
      ...(input.tools ? { tools: input.tools.map(t => ({ type: 'function', function: t })) } : {}) } };
  },
  decode(route, raw) {
    const root = object(raw), choices = array(root.choices, 1);
    if (choices.length !== 1) return invalidResponse();
    const choice = object(choices[0]), m = object(choice.message);
    if (m.role !== 'assistant' || !['stop', 'length', 'tool_calls', 'content_filter'].includes(String(choice.finish_reason))) return invalidResponse();
    const text = m.content == null ? '' : string(m.content);
    const calls = m.tool_calls === undefined ? [] : array(m.tool_calls, 16).map(v => { const c = object(v), f = object(c.function); if (c.type !== 'function') return invalidResponse(); return call(c.id, f.name, argumentsObject(f.arguments)); });
    return reply(route, text, calls, choice.finish_reason === 'length' ? 'length' : choice.finish_reason === 'content_filter' || m.refusal ? 'refused' : choice.finish_reason === 'tool_calls' ? 'tools' : 'end', usage(root.usage, 'prompt_tokens', 'completion_tokens'), m.reasoning_content === undefined ? undefined : string(m.reasoning_content));
  },
  discovery() { return { path: '/models', headers: {} }; },
  decodeDiscovery(raw, firstPage) { const root = object(raw), { items, truncated } = discoveryItems(root.data, firstPage); return { models: items.map(v => discovered(v)), ...(truncated || root.has_more === true ? { truncated: true } : {}) }; },
};
