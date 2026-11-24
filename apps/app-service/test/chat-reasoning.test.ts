import assert from 'node:assert/strict';
import test from 'node:test';
import { chatOptions, resolveChatRoute } from '../src/models/chat-models.ts';
import { adapters } from '../src/models/protocols.ts';
import { configuration } from './fixtures/models.ts';
import { validOnlineChatInput, isChatListResult } from '../../../packages/contracts/src/online-chat.ts';

const setup = () => {
 const state = configuration('responses');
 const connection = state.connections[0]!;
 connection.baseURL = 'https://api.openai.com/v1';
 connection.models[0]!.modelID = 'gpt-6.2-sol';
 return state;
};
test('chat advertises supported reasoning and defaults to high without changing saved configuration', () => {
 const state = setup(), model = chatOptions(state)[0]!;
 assert.deepEqual(model.reasoningLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
 assert.equal(model.reasoningEffort, 'high');
 assert.equal(state.connections[0]!.models[0]!.reasoningEffort, undefined);
 assert.equal(isChatListResult({ ok: true, models: [model] }), true);
 assert.equal(isChatListResult({ ok: true, models: [{ ...model, reasoningEffort: 'none' }] }), false);
});
test('per-turn reasoning is encoded on the saved route without persisting or changing fingerprint', () => {
 const state = setup(), model = chatOptions(state)[0]!;
 const route = resolveChatRoute(state, model.route, 'low');
 assert.equal(route.reasoningEffort, 'low');
 assert.equal(route.fingerprint, model.route.fingerprint);
 const encoded = adapters.responses.encode(route, { messages: [{ role: 'user', text: '合成问题' }] });
 assert.deepEqual(encoded.body.reasoning, { effort: 'low' });
 assert.equal(state.connections[0]!.models[0]!.reasoningEffort, undefined);
 assert.throws(() => resolveChatRoute(state, model.route, 'none'), /invalid_request/);
 const unknown = configuration('responses');
 assert.throws(() => resolveChatRoute(unknown, chatOptions(unknown)[0]!.route, 'high'), /invalid_request/);
});
test('chat request accepts only bounded known reasoning strings', () => {
 const request = { requestID: '11111111-1111-4111-8111-111111111111', petID: 'pet-one', route: chatOptions(setup())[0]!.route, text: '合成问题', history: [] };
 assert.equal(validOnlineChatInput({ ...request, reasoningEffort: 'high' }), true);
 for (const reasoningEffort of ['ultra', '', null, {}, ['high']]) assert.equal(validOnlineChatInput({ ...request, reasoningEffort }), false);
});
test('screenshot routes support their native thinking parameters without granting arbitrary gateways', () => {
 const state = setup(), connection = state.connections[0]!;
 connection.baseURL = 'https://timicc.com/v1';
 const sol = chatOptions(state)[0]!;
 assert.deepEqual(sol.reasoningLevels, ['low', 'medium', 'high', 'xhigh']);
 const input = { messages: [{ role: 'user' as const, text: '合成问题' }] };
 assert.deepEqual(adapters.responses.encode(resolveChatRoute(state, sol.route, 'xhigh'), input).body.reasoning, { effort: 'xhigh' });
 connection.baseURL = 'https://api.deepseek.com/v1';
 connection.apiProtocol = 'chat-completions';
 connection.models[0]!.modelID = 'deepseek-flash';
 const deepseek = chatOptions(state)[0]!;
 assert.deepEqual(deepseek.reasoningLevels, ['none', 'low', 'high', 'max']);
 assert.equal(adapters['chat-completions'].encode(resolveChatRoute(state, deepseek.route, 'none'), input).body.reasoning_effort, 'none');
 connection.baseURL = 'https://synthetic.invalid/v1';
 assert.equal(chatOptions(state)[0]!.reasoningLevels, undefined);
});
