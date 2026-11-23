import assert from 'node:assert/strict';
import test from 'node:test';
import { validateConfiguration, resolveRoute, validateBaseURL } from '../src/models/config.ts';
import { chatOptions } from '../src/models/chat-models.ts';
import { configuration } from './fixtures/models.ts';

const invalid = (value: unknown) => assert.throws(() => validateConfiguration(value), /invalid_configuration/);
test('multi-connection schema keeps provider, connection and model separate with explicit defaults', () => {
  const value = configuration(); const second = structuredClone(value.connections[0]!);
  second.id = 'connection-two'; second.credentialRef = 'credential-version-two'; value.connections.push(second);
  assert.deepEqual(validateConfiguration(value), value);
  assert.equal(resolveRoute(value, undefined, 'text-chat').connectionID, 'connection-one');
  value.defaultConnectionID = null;
  assert.throws(() => resolveRoute(value, undefined, 'text-chat'), /not_configured/);
  assert.deepEqual(validateConfiguration({schemaVersion:2,revision:0,connections:[],defaultConnectionID:null}).connections, []);
});
test('configuration rejects unknown versions, extra secret/path fields, duplicate IDs and dangling defaults', () => {
  for(const patch of [{schemaVersion:3},{apiKey:'synthetic-secret'},{path:'/private'},{revision:-1},{defaultConnectionID:'missing'}]) invalid({...configuration(),...patch});
  const value=configuration();value.connections.push(structuredClone(value.connections[0]!));invalid(value);
  const entry=configuration();entry.connections[0]!.models.push(structuredClone(entry.connections[0]!.models[0]!));invalid(entry);
  const dangling=configuration();dangling.connections[0]!.defaultModelEntryID='missing';invalid(dangling);
  const secret=configuration();Object.assign(secret.connections[0]!,{apiKey:'never-store-this'});invalid(secret);
});
test('counts and UTF-8 bounds match 32 connections, 33 models and 1MiB total without guessing capacity', () => {
  const value=configuration();value.connections=Array.from({length:32},(_,i)=>({...structuredClone(value.connections[0]!),id:`c-${i}`,credentialRef:`credential-${i}`}));value.defaultConnectionID='c-0';
  const c=value.connections[0]!;c.models=Array.from({length:33},(_,i)=>({...structuredClone(c.models[0]!),entryID:`e-${i}`,modelID:`m-${i}`}));c.defaultModelEntryID='e-0';
  assert.equal(validateConfiguration(value).connections.length,32);
  value.connections.push({...c,id:'overflow'});invalid(value);
  for(const field of ['displayName','modelID'] as const){const x=configuration();x.connections[0]!.models[0]![field]='字'.repeat(100);invalid(x);}
  for(const capacity of [0,-1,Infinity,2_147_483_648,1.5]){const x=configuration();x.connections[0]!.models[0]!.maxOutputTokens=capacity;invalid(x);}
  const limit=configuration();limit.connections[0]!.models[0]!.maxOutputTokens=2_147_483_647;assert.ok(validateConfiguration(limit));
});
test('base URLs retain prefixes, never guess versions and reject generation endpoints or credential-bearing URLs', () => {
  assert.equal(validateBaseURL('https://synthetic.invalid/deploy/v1/', 'responses'),'https://synthetic.invalid/deploy/v1');
  for(const url of ['http://remote.invalid/v1','https://key@synthetic.invalid/v1','https://synthetic.invalid/v1?key=x','https://synthetic.invalid/v1#x','file:///tmp/config','https://synthetic.invalid/a/../v1','https://synthetic.invalid/%2e%2e/v1','https://synthetic.invalid/v1/chat/completions','https://synthetic.invalid/v1/messages','https://synthetic.invalid/v1/responses','https://synthetic.invalid/v1\\other']) assert.throws(()=>validateBaseURL(url,'chat-completions'),/invalid_configuration/,url);
  assert.throws(()=>validateBaseURL('https://synthetic.invalid/prefix','gemini'),/invalid_configuration/);
  for(const host of ['localhost','127.0.0.1','[::1]']) assert.ok(validateBaseURL(`http://${host}:1234/prefix`,'chat-completions'));
});
test('only explicit loopback auth none omits credentials and protocol-incompatible options are rejected', () => {
  const x=configuration();x.connections[0]!.authMode='none';delete x.connections[0]!.credentialRef;invalid(x);
  x.connections[0]!.baseURL='http://127.0.0.1:2345/v1';assert.ok(validateConfiguration(x));
  x.connections[0]!.credentialRef='should-not-survive';invalid(x);
  const options=configuration();options.connections[0]!.compatibility={outputTokenField:'max_tokens'};assert.ok(validateConfiguration(options));
  options.connections[0]!.apiProtocol='anthropic';invalid(options);
  Object.assign(configuration().connections[0]!,{apiProtocol:'deepseek-messages'});
  const unsupported=configuration();Object.assign(unsupported.connections[0]!,{apiProtocol:'deepseek-messages'});invalid(unsupported);
});
test('route confirmations survive renaming but not address, credential, protocol, model API ID or compatibility changes', () => {
  const x=configuration();const first=resolveRoute(x,undefined,'text-chat');const selection={connectionID:first.connectionID,modelEntryID:first.modelEntryID,fingerprint:first.fingerprint};
  x.connections[0]!.displayName='新名称';x.connections[0]!.models[0]!.displayName='模型新名称';x.revision++;
  assert.equal(resolveRoute(x,selection,'text-chat').fingerprint,first.fingerprint);
  for(const mutate of [(v:typeof x)=>{v.connections[0]!.baseURL+='-other';},(v:typeof x)=>{v.connections[0]!.credentialRef='credential-new';},(v:typeof x)=>{v.connections[0]!.apiProtocol='responses';},(v:typeof x)=>{v.connections[0]!.models[0]!.modelID='other';},(v:typeof x)=>{v.connections[0]!.compatibility={outputTokenField:'max_tokens'};}]){
    const changed=structuredClone(x);mutate(changed);assert.throws(()=>resolveRoute(changed,selection,'text-chat'),/route_changed/);
  }
  x.connections=[];x.defaultConnectionID=null;assert.throws(()=>resolveRoute(x,selection,'text-chat'),/route_changed/);
});

test('schema v2 keeps legacy models readable and validates explicit reasoning and input modalities', () => {
  const legacy = configuration();
  assert.equal(validateConfiguration(legacy).connections[0]!.models[0]!.reasoningEffort, undefined);
  assert.equal(validateConfiguration(legacy).connections[0]!.models[0]!.inputModalities, undefined);

  const responses = configuration('responses');
  responses.connections[0]!.baseURL = 'https://api.openai.com/v1';
  responses.connections[0]!.models[0]!.modelID = 'gpt-6.2-astra';
  const model = responses.connections[0]!.models[0]!;
  model.reasoningEffort = 'high';
  model.inputModalities = ['image', 'pdf'];
  assert.deepEqual(validateConfiguration(responses).connections[0]!.models[0], model);

  for (const invalidModel of [
    { ...model, reasoningEffort: 'ultra' },
    { ...model, inputModalities: ['image', 'image'] },
    { ...model, inputModalities: ['pdf'] },
  ]) {
    const invalidValue = configuration('responses');
    invalidValue.connections[0]!.baseURL = 'https://api.openai.com/v1';
    invalidValue.connections[0]!.models[0]!.modelID = 'gpt-6.2-astra';
    invalidValue.connections[0]!.models[0] = invalidModel as typeof model;
    invalid(invalidValue);
  }

  const nonResponses = configuration('chat-completions');
  nonResponses.connections[0]!.models[0]!.inputModalities = ['image'];
  invalid(nonResponses);
});

test('model reasoning and modalities are part of the immutable route identity', () => {
  const value = configuration('responses');
  const connection = value.connections[0]!;
  connection.baseURL = 'https://api.openai.com/v1';
  connection.models[0]!.modelID = 'gpt-6.2-astra';
  connection.models[0]!.reasoningEffort = 'low';
  connection.models[0]!.inputModalities = ['image'];
  const first = resolveRoute(value, undefined, 'text-chat');
  assert.equal(first.reasoningEffort, 'low');
  assert.deepEqual(first.inputModalities, ['image']);

  const selection = { connectionID: first.connectionID, modelEntryID: first.modelEntryID, fingerprint: first.fingerprint };
  connection.models[0]!.reasoningEffort = 'high';
  assert.throws(() => resolveRoute(value, selection, 'text-chat'), /route_changed/);
  const updated = resolveRoute(value, undefined, 'text-chat');
  connection.models[0]!.reasoningEffort = 'high';
  connection.models[0]!.inputModalities = ['image', 'pdf'];
  assert.notEqual(resolveRoute(value, undefined, 'text-chat').fingerprint, updated.fingerprint);
});
test('purpose budgets are capped only by confirmed output capacity and returned snapshots are independent', () => {
  const x=configuration();assert.equal(resolveRoute(x,undefined,'text-chat').tokenBudget,2048);assert.equal(resolveRoute(x,undefined,'text-chat').timeoutMs,60_000);
  assert.equal(resolveRoute(x,undefined,'speech').tokenBudget,160);assert.equal(resolveRoute(x,undefined,'speech').timeoutMs,25_000);
  x.connections[0]!.models[0]!.maxOutputTokens=32;const route=resolveRoute(x,undefined,'text-chat');assert.equal(route.tokenBudget,32);
  x.connections[0]!.models[0]!.modelID='changed';assert.equal(route.modelID,'synthetic-model');
});
test('strict schema never coerces default IDs or enum fields and enforces every count and aggregate byte bound', () => {
  const numeric = configuration(); numeric.connections[0]!.models[0]!.entryID = '1'; Object.assign(numeric.connections[0]!, { defaultModelEntryID: 1 }); invalid(numeric);
  const enumObject = configuration(); Object.assign(enumObject.connections[0]!, { preset: { toString: () => 'openai' } }); invalid(enumObject);
  const tooMany = configuration(); tooMany.connections[0]!.models = Array.from({ length: 34 }, (_, i) => ({ ...structuredClone(tooMany.connections[0]!.models[0]!), entryID: `entry-${i}`, modelID: `model-${i}` })); tooMany.connections[0]!.defaultModelEntryID = 'entry-0'; invalid(tooMany);
  const aggregate = configuration(), base = aggregate.connections[0]!;
  aggregate.connections = Array.from({ length: 32 }, (_, c) => ({ ...structuredClone(base), id: `c-${c}`, credentialRef: `credential-${c}`, displayName: 'd'.repeat(128), baseURL: `https://synthetic.invalid/${'p'.repeat(1700)}`, models: Array.from({ length: 33 }, (_, m) => ({ ...structuredClone(base.models[0]!), entryID: `e-${m}-${'e'.repeat(100)}`, modelID: `m-${m}-${'"'.repeat(240)}`, displayName: '"'.repeat(128) })), defaultModelEntryID: `e-0-${'e'.repeat(100)}` }));
  aggregate.defaultConnectionID = 'c-0'; assert.ok(Buffer.byteLength(JSON.stringify(aggregate)) > 1_048_576); invalid(aggregate);
});
test('API-key connections can be saved without a key but cannot share one credential-version reference across connections', () => {
  const missing = configuration(); delete missing.connections[0]!.credentialRef;
  assert.ok(validateConfiguration(missing)); assert.equal(resolveRoute(missing, undefined, 'text-chat').credentialRef, undefined);
  const shared = configuration(); shared.connections.push({ ...structuredClone(shared.connections[0]!), id: 'connection-two' }); invalid(shared);
  shared.connections[1]!.credentialRef = 'credential-version-two'; assert.ok(validateConfiguration(shared));
});


test('canonical Responses models get verified attachment defaults; lookalikes and other protocols do not', () => {
  const config = configuration('responses');
  const connection = config.connections[0]!, entry = connection.models[0]!;
  entry.modelID = 'gpt-4.1'; connection.baseURL = 'https://api.openai.com/v1/';
  assert.deepEqual(resolveRoute(config, undefined, 'text-chat').inputModalities, ['image', 'pdf']);
  assert.deepEqual(chatOptions(config)[0]?.inputModalities, ['image', 'pdf']);
  assert.equal(entry.inputModalities, undefined); // Effective metadata is never written back to storage.
  entry.inputModalities = [];
  assert.deepEqual(chatOptions(config)[0]?.inputModalities, []);
  delete entry.inputModalities;
  entry.modelID = 'gpt-4.1-lookalike';
  assert.equal(chatOptions(config)[0]?.inputModalities, undefined);
  entry.modelID = 'gpt-4.1'; connection.baseURL = 'http://127.0.0.1:9180/v1';
  assert.equal(chatOptions(config)[0]?.inputModalities, undefined);
  connection.baseURL = 'https://api.openai.com/v1'; connection.apiProtocol = 'chat-completions';
  assert.equal(chatOptions(config)[0]?.inputModalities, undefined);
});
