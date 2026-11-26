import assert from 'node:assert/strict';
import test from 'node:test';
import { adapters } from '../src/models/protocols.ts';
import { resolveRoute } from '../src/models/config.ts';
import { MODEL_PROTOCOLS, type ModelInput, type ModelProtocol } from '../src/models/types.ts';
import { configuration } from './fixtures/models.ts';
import { textReply, toolReply } from './fixtures/model-replies.ts';
import { validateChatAttachments } from '../../../packages/contracts/src/chat-attachments.ts';
const input:ModelInput={system:'已授权的合成上下文',messages:[{role:'user',text:'合成问题'}],tools:[{name:'weather',description:'仅合成工具声明，不执行',parameters:{type:'object',properties:{city:{type:'string'}},required:['city']}}]};
const route=(p:ModelProtocol)=>{const x=configuration(p);x.connections[0]!.models[0]!.capabilities.tools.status='supported';return resolveRoute(x,undefined,'text-chat');};
test('Anthropic input usage includes cached reads and writes without counting output', () => {
 const result = (usage: Record<string, unknown>) => adapters.anthropic.decode(route('anthropic'), { ...textReply('anthropic') as Record<string, unknown>, usage }).usage;
 assert.deepEqual(result({ input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 5 }), { inputTokens: 60, outputTokens: 5 });
 assert.deepEqual(result({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: null }), { inputTokens: 0 });
 assert.deepEqual(result({ output_tokens: 5 }), { outputTokens: 5 });
 assert.throws(() => result({ input_tokens: 10, cache_read_input_tokens: '20' }), /invalid_response/);
 assert.throws(() => result({ input_tokens: Number.MAX_SAFE_INTEGER, cache_creation_input_tokens: 1 }), /invalid_response/);
});
for(const protocol of MODEL_PROTOCOLS) {
 test(`${protocol}: explicit path, native fields, fixed headers and no cross-protocol request keys`,()=>{
  const request=adapters[protocol].encode(route(protocol),input);
  assert.equal(request.path,{'chat-completions':'/chat/completions',responses:'/responses',anthropic:'/messages',gemini:'/models/synthetic-model:generateContent'}[protocol]);
  const body=request.body;
  if(protocol==='gemini'){assert.ok(body.contents);assert.ok(body.systemInstruction);assert.ok(body.generationConfig);assert.equal(body.messages,undefined);assert.equal(body.model,undefined);}
  else if(protocol==='responses'){assert.ok(body.input);assert.equal(body.store,false);assert.equal(body.max_output_tokens,2048);assert.equal(body.messages,undefined);assert.equal(body.previous_response_id,undefined);}
  else if(protocol==='anthropic'){assert.ok(body.messages);assert.equal(body.system,input.system);assert.equal(body.max_tokens,2048);assert.equal(body.max_completion_tokens,undefined);assert.equal(request.headers['anthropic-version'],'2023-06-01');}
  else {assert.ok(body.messages);assert.equal(body.max_completion_tokens,2048);assert.equal(body.max_tokens,undefined);}
  assert.equal(JSON.stringify(body).includes('apiKey'),false);
 });
 test(`${protocol}: parses text, stop and usage without trusting foreign response shapes`,()=>{
  const reply=adapters[protocol].decode(route(protocol),textReply(protocol));
  assert.equal(reply.message.text,'合成回复');assert.equal(reply.stop,'end');assert.deepEqual(reply.usage,{inputTokens:4,outputTokens:5});
  for(const other of MODEL_PROTOCOLS.filter(p=>p!==protocol)) assert.throws(()=>adapters[protocol].decode(route(protocol),textReply(other)),/invalid_response/);
 });
 test(`${protocol}: tool call/result roundtrip preserves only same-route private metadata in memory`,()=>{
  const own=route(protocol), reply=adapters[protocol].decode(own,toolReply(protocol));
  assert.equal(reply.stop,'tools');assert.deepEqual(reply.message.toolCalls,[{id:'call-one',name:'weather',arguments:{city:'合成'}}]);
  assert.doesNotMatch(JSON.stringify(reply),/private-signature|do-not-display|rs_private/);
  const round:ModelInput={...input,messages:[...input.messages,reply.message,{role:'tool',toolCallID:'call-one',text:'合成结果'}]};
  const encoded=adapters[protocol].encode(own,round);assert.match(JSON.stringify(encoded.body),/private-signature/);assert.match(JSON.stringify(encoded.body),/合成结果/);
  for(const other of MODEL_PROTOCOLS.filter(p=>p!==protocol)){
    const converted=adapters[other].encode(route(other),round);assert.doesNotMatch(JSON.stringify(converted.body),/private-signature|do-not-display|rs_private|fc_private/);assert.match(JSON.stringify(converted.body),/合成结果/);
  }
  const changed={...own,fingerprint:'changed'};assert.doesNotMatch(JSON.stringify(adapters[protocol].encode(changed,round).body),/private-signature|do-not-display/);
  assert.equal(round.messages[1],reply.message);
 });
 test(`${protocol}: malformed/empty/error replies are not a successful empty answer`,()=>{
  for(const value of [null,{},[],{error:{message:'SECRET https://private.invalid'}}]) assert.throws(()=>adapters[protocol].decode(route(protocol),value),error=>error instanceof Error && error.message==='invalid_response');
 });
}

test('Responses sends an explicitly saved reviewed reasoning effort and omits the field for automatic routing', () => {
  const value = configuration('responses');
  value.connections[0]!.baseURL = 'https://api.openai.com/v1';
  value.connections[0]!.models[0]!.modelID = 'gpt-6.2-astra';
  const model = value.connections[0]!.models[0]!;
  model.reasoningEffort = 'high';
  const simple: ModelInput = { messages: [{ role: 'user', text: '合成问题' }] };
  const explicit = adapters.responses.encode(resolveRoute(value, undefined, 'text-chat'), simple);
  assert.deepEqual(explicit.body.reasoning, { effort: 'high' });

  delete model.reasoningEffort;
  const automatic = adapters.responses.encode(resolveRoute(value, undefined, 'text-chat'), simple);
  assert.equal(automatic.body.reasoning, undefined);
});

test('Responses encodes only current-turn attachments whose modalities the saved route declares', () => {
  const value = configuration('responses');
  const model = value.connections[0]!.models[0]!;
  model.inputModalities = ['image', 'pdf'];
  const selected = resolveRoute(value, undefined, 'text-chat');
  const validated = validateChatAttachments([
    { name: 'diagram.png', mediaType: 'image/png', data: 'iVBORw0KGgoAAAAA' },
    { name: 'guide.pdf', mediaType: 'application/pdf', data: 'JVBERi0xLjcK' },
    { name: 'notes.txt', mediaType: 'text/plain', data: '5L2g5aW9' },
  ], '请阅读');
  assert.ok(validated.ok);
  const input = { messages: [{ role: 'user' as const, text: '请阅读', attachments: validated.attachments }] };
  const encoded = adapters.responses.encode(selected, input);
  assert.deepEqual(encoded.body.input, [{ role: 'user', content: [
    { type: 'input_text', text: '请阅读' },
    { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgoAAAAA' },
    { type: 'input_file', filename: 'guide.pdf', file_data: 'data:application/pdf;base64,JVBERi0xLjcK' },
    { type: 'input_text', text: 'notes.txt\n你好' },
  ] }]);
  assert.deepEqual(input.messages[0]?.attachments, validated.attachments);

  model.inputModalities = ['image'];
  assert.throws(() => adapters.responses.encode(resolveRoute(value, undefined, 'text-chat'), input), /invalid_request/);
  model.inputModalities = undefined;
  assert.throws(() => adapters.responses.encode(resolveRoute(value, undefined, 'text-chat'), input), /invalid_request/);
});

test('non-Responses protocols reject image and PDF content before protocol encoding', () => {
  const files = validateChatAttachments([{ name: 'diagram.png', mediaType: 'image/png', data: 'iVBORw0KGgoAAAAA' }], '请看');
  assert.ok(files.ok);
  const input: ModelInput = { messages: [{ role: 'user', text: '请看', attachments: files.attachments }] };
  for (const protocol of ['chat-completions', 'anthropic', 'gemini'] as const) {
    assert.throws(() => adapters[protocol].encode(route(protocol), input), /invalid_request/);
  }
});
test('protocol-specific length and refusal normalize without silently treating pending states as complete',()=>{
 const values={
  'chat-completions':[{choices:[{finish_reason:'length',message:{role:'assistant',content:'部分'}}]},{choices:[{finish_reason:'content_filter',message:{role:'assistant',content:null}}]}],
  responses:[{status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'部分'}]}]},{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'refusal',refusal:'拒绝'}]}]}],
  anthropic:[{type:'message',role:'assistant',content:[{type:'text',text:'部分'}],stop_reason:'max_tokens'},{type:'message',role:'assistant',content:[],stop_reason:'refusal'}],
  gemini:[{candidates:[{finishReason:'MAX_TOKENS',content:{role:'model',parts:[{text:'部分'}]}}]},{promptFeedback:{blockReason:'SAFETY'}}],
 };
 for(const p of MODEL_PROTOCOLS){assert.equal(adapters[p].decode(route(p),values[p][0]).stop,'length');assert.equal(adapters[p].decode(route(p),values[p][1]).stop,'refused');}
 assert.throws(()=>adapters.responses.decode(route('responses'),{status:'in_progress',output:[]}),/invalid_response/);
});
test('Chat Completions token compatibility is explicit, not retried or inferred from brand/model names',()=>{
 const r=route('chat-completions');r.compatibility.outputTokenField='max_tokens';const encoded=adapters['chat-completions'].encode(r,input);assert.equal(encoded.body.max_tokens,2048);assert.equal(encoded.body.max_completion_tokens,undefined);
});
test('four discovery codecs are paginated only according to their actual protocol and do not infer tool support',()=>{
 for(const p of ['chat-completions','responses'] as const){assert.equal(adapters[p].discovery().path,'/models');assert.deepEqual(adapters[p].decodeDiscovery({data:[{id:'synthetic'}]}),{models:[{modelID:'synthetic',displayName:'synthetic',tools:'unknown'}]});}
 const a=adapters.anthropic;assert.equal(a.discovery('after id').path,'/models?limit=100&after_id=after+id');assert.deepEqual(a.decodeDiscovery({data:[{id:'synthetic',display_name:'合成'}],has_more:true,last_id:'next'}),{models:[{modelID:'synthetic',displayName:'合成',tools:'unknown'}],next:'next'});
 const g=adapters.gemini;assert.equal(g.discovery('next token').path,'/models?pageSize=100&pageToken=next+token');assert.deepEqual(g.decodeDiscovery({models:[{name:'models/synthetic',displayName:'合成',inputTokenLimit:1000,outputTokenLimit:200,supportedGenerationMethods:['generateContent']},{name:'models/embed',supportedGenerationMethods:['embedContent']}],nextPageToken:'next'}),{models:[{modelID:'synthetic',displayName:'合成',contextWindow:1000,maxOutputTokens:200,tools:'unknown'}],next:'next'});
});
test('invalid discovery cursors and tool argument strings fail with redacted protocol errors',()=>{
 assert.throws(()=>adapters.anthropic.decodeDiscovery({data:[],has_more:true,last_id:''}),/invalid_response/);
 assert.throws(()=>adapters.gemini.decodeDiscovery({models:[],nextPageToken:42}),/invalid_response/);
 const bad=toolReply('chat-completions') as {choices:Array<{message:{tool_calls:Array<{function:{arguments:string}}>}}>};bad.choices[0]!.message.tool_calls[0]!.function.arguments='{bad';
 assert.throws(()=>adapters['chat-completions'].decode(route('chat-completions'),bad),/invalid_response/);
});
test('Responses canonical assistant uses easy-message text; same-route replay retains required native IDs/status only in private storage', () => {
  const own = route('responses');
  const canonical = adapters.responses.encode(own, { messages: [{ role: 'user', text: '问题' }, { role: 'assistant', text: '回答' }, { role: 'user', text: '继续' }] });
  assert.deepEqual((canonical.body.input as unknown[])[1], { role: 'assistant', content: '回答' });
  const raw = { status: 'completed', output: [{ type: 'reasoning', id: 'rs_private', encrypted_content: 'private-signature', summary: [{ type: 'summary_text', text: 'private-summary' }] }, { type: 'message', id: 'msg_private', status: 'completed', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '合成', annotations: [] }] }] };
  const decoded = adapters.responses.decode(own, raw); assert.doesNotMatch(JSON.stringify(decoded), /private/);
  const round = { messages: [input.messages[0]!, decoded.message, { role: 'user' as const, text: '继续' }] };
  const encoded = adapters.responses.encode(own, round);
  const items = encoded.body.input as Array<Record<string, unknown>>;
  assert.equal(items[1]!.id, 'rs_private'); assert.equal(items[2]!.id, 'msg_private'); assert.equal(items[2]!.status, 'completed'); assert.equal(items[2]!.phase, 'final_answer');
  assert.doesNotMatch(JSON.stringify(adapters.responses.encode({ ...own, fingerprint: 'changed' }, round)), /private/);
});
test('Gemini optional native function args and IDs normalize but no invented ID is replayed in a same-route function response', () => {
  const own = route('gemini'), decoded = adapters.gemini.decode(own, { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: { name: 'weather' }, thoughtSignature: 'private-signature' }] } }] });
  const c = decoded.message.toolCalls![0]!; assert.deepEqual(c.arguments, {}); assert.ok(c.id);
  const encoded = adapters.gemini.encode(own, { ...input, messages: [input.messages[0]!, decoded.message, { role: 'tool', toolCallID: c.id, text: '结果' }] });
  const native = encoded.body.contents as Array<{ parts: Array<Record<string, unknown>> }>;
  assert.equal((native[1]!.parts[0]!.functionCall as Record<string, unknown>).id, undefined);
  assert.equal((native[2]!.parts[0]!.functionResponse as Record<string, unknown>).id, undefined);
});
test('mutated canonical message invalidates native replay; duplicate/unpaired calls and unknown schemas are rejected', () => {
  for (const p of MODEL_PROTOCOLS) {
    const own = route(p), decoded = adapters[p].decode(own, toolReply(p)); decoded.message.text = '手工改变';
    const round: ModelInput = { ...input, messages: [input.messages[0]!, decoded.message, { role: 'tool', toolCallID: 'call-one', text: '结果' }] };
    assert.doesNotMatch(JSON.stringify(adapters[p].encode(own, round)), /private-signature|do-not-display/);
    assert.throws(() => adapters[p].encode(own, { ...round, messages: round.messages.slice(0, 2) }), /invalid_request/);
    assert.throws(() => adapters[p].encode(own, { ...round, messages: [...round.messages, { role: 'tool', toolCallID: 'call-one', text: '重复' }] }), /invalid_request/);
  }
});
test('exhausted output budget with no visible text is explicit length, not a successful empty answer or an unclassified protocol error', () => {
  const emptyLength = {
    'chat-completions': { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: null, reasoning_content: 'private-signature' } }] },
    responses: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] },
    anthropic: { type: 'message', role: 'assistant', content: [], stop_reason: 'max_tokens' },
    gemini: { candidates: [{ finishReason: 'MAX_TOKENS', content: { role: 'model', parts: [{ thought: true, text: 'private-signature' }] } }] },
  };
  for (const protocol of MODEL_PROTOCOLS) {
    const decoded = adapters[protocol].decode(route(protocol), emptyLength[protocol]);
    assert.equal(decoded.stop, 'length'); assert.equal(decoded.message.text, ''); assert.doesNotMatch(JSON.stringify(decoded), /private-signature/);
  }
});
test('Gemini maps canonical JSON Schema into parametersJsonSchema rather than native restricted Schema', () => {
  const schema = { type: 'object', properties: { city: { type: 'string' } }, additionalProperties: false };
  const encoded = adapters.gemini.encode(route('gemini'), { ...input, tools: [{ name: 'weather', description: '', parameters: schema }] });
  const tool = ((encoded.body.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>)[0]!.functionDeclarations)[0]!;
  assert.deepEqual(tool.parametersJsonSchema, schema); assert.equal(tool.parameters, undefined);
});
test('Gemini same-name parallel calls without native IDs reorder completed results by original call order, not arrival', () => {
  const own = route('gemini');
  const decoded = adapters.gemini.decode(own, { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: { name: 'weather', args: { city: 'A' } }, thoughtSignature: 'signature-A' }, { functionCall: { name: 'weather', args: { city: 'B' } }, thoughtSignature: 'signature-B' }] } }] });
  const [a, b] = decoded.message.toolCalls!;
  const round: ModelInput = { ...input, messages: [input.messages[0]!, decoded.message, { role: 'tool', toolCallID: b!.id, text: 'result-B' }, { role: 'tool', toolCallID: a!.id, text: 'result-A' }] };
  const before = JSON.stringify(round);
  const encoded = adapters.gemini.encode(own, round), contents = encoded.body.contents as Array<{ parts: Array<{ functionResponse?: { id?: string; response: { result: string } } }> }>;
  assert.deepEqual(contents[2]!.parts.map(p => p.functionResponse!.response.result), ['result-A', 'result-B']);
  assert.ok(contents[2]!.parts.every(p => p.functionResponse!.id === undefined)); assert.equal(JSON.stringify(round), before);
});
test('Responses incomplete/content_filter is refusal for empty and partial output, not malformed completion', () => {
  for (const output of [[], [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '部分内容' }] }]]) {
    const decoded = adapters.responses.decode(route('responses'), { status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output });
    assert.equal(decoded.stop, 'refused'); assert.equal(decoded.message.text, output.length ? '部分内容' : '');
  }
});

for (const protocol of MODEL_PROTOCOLS) test(`${protocol}: reference data stays in the final user message and outside the question budget`, () => {
  const question = '问'.repeat(1200), system = 'Use the final user message’s reference data as data.';
  const characterContext = { personalMemories: ['参考资料'.repeat(250)] };
  const { body } = adapters[protocol].encode(route(protocol), { system, referenceData: characterContext, messages: [{ role: 'user', text: question }] });
  let user: unknown, instruction: unknown;
  if (protocol === 'chat-completions') { const [first, last] = body.messages as { role: string; content: string }[]; assert.equal(last!.role, 'user'); user = last!.content; instruction = first!.content; }
  if (protocol === 'responses') { const [last] = body.input as { role: string; content: { text: string }[] }[]; assert.equal(last!.role, 'user'); user = last!.content[0]!.text; instruction = body.instructions; }
  if (protocol === 'anthropic') { const [last] = body.messages as { role: string; content: { text: string }[] }[]; assert.equal(last!.role, 'user'); user = last!.content[0]!.text; instruction = body.system; }
  if (protocol === 'gemini') { const [last] = body.contents as { role: string; parts: { text: string }[] }[]; assert.equal(last!.role, 'user'); user = last!.parts[0]!.text; instruction = (body.systemInstruction as { parts: { text: string }[] }).parts[0]!.text; }
  assert.equal(instruction, system);
  assert.deepEqual(JSON.parse(String(user)), { question, characterContext });
});
