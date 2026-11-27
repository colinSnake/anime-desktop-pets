import { LiveVoiceProfileStore } from '../src/live/voice-profiles.ts';
import { AgentStateStore } from '../src/agent/agent-state.ts';
import { createPiTextRuntime } from '../src/agent/pi-runtime.ts';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ChatHistory } from '../src/chat-history.ts';
import { chatHistoryPaths, isHistoryDetailResult } from '../../../packages/contracts/src/chat-history.ts';
import { ModelManagement } from '../src/models/management.ts';
import { PetWorkspace } from '../src/pet-workspace.ts';
import { CharacterRepository } from '../src/characters/repository.ts';
import { BubbleSpeech } from '../src/speech/bubble-speech.ts';
import { LiveProfileStore } from '../src/live/profile.ts';
import { LiveRoleBindingStore } from '../src/live/role-bindings.ts';
import { LiveShareStore } from '../src/live/sharing.ts';
import { createService } from '../src/server.ts';
import { sendOnlineChat } from '../src/online-chat.ts';
import { TextChatTurns, type TextChatRuntime } from '../src/agent/text-chat-runtime.ts';
import { longmei } from '../../../packages/contracts/src/built-in-pets.ts';
import { configuration } from './fixtures/models.ts';
import { syntheticVault } from './fixtures/secure-models.ts';

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

const use = { skip: process.platform === 'win32' };
const token = 'a'.repeat(64), headers = { host: '127.0.0.1', authorization: `Bearer ${token}` };
const paths = { list: '/v1/chat/models', send: '/v1/chat/send' };
const key = 'SYNTHETIC-CHAT-KEY';
const completion = (content = '合成回应') => Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const writeDraft = (id: string) => {
  const { revision, credentialRef, ...draft } = configuration().connections[0]!;
  return { ...draft, id, displayName: id, baseURL: `https://${id}.invalid/v1` };
};
const syntheticRuntime: TextChatRuntime = (text, complete) => complete(text);
async function fixture(t: test.TestContext, fetch: typeof globalThis.fetch, beforeRead?: () => Promise<void>, chatRuntime: TextChatRuntime | null = syntheticRuntime, withHistory = false, withAgentState = false, speech?: BubbleSpeech, withLiveRoles = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pet-online-chat-')));
  const { backend } = syntheticVault(); let reads = 0;
  const models = new ModelManagement(join(root, 'models'), { ...backend, read: async (...args) => { reads++; await beforeRead?.(); return backend.read(...args); } }, undefined, { fetch });
  const pkg = withLiveRoles ? longmei : { id: 'local.pet', version: '1.0.0' };
  const workspace = new PetWorkspace({ root, catalog: [{ ...pkg, name: withLiveRoles ? '龙妹' : '合成桌宠' }] });
  const characters = new CharacterRepository(join(root, 'characters'));
  const liveRoleBindings = withLiveRoles ? new LiveRoleBindingStore(join(root, 'live')) : undefined;
  const liveShares = withLiveRoles ? new LiveShareStore(join(root, 'live')) : undefined;
  const snapshot = () => ({ kind: 'diagnostic' as const, status: 'idle' as const, detail: '' });
  const historyFile = join(root, 'chats.sqlite');
  if (withHistory) await writeFile(historyFile, '', { mode: 0o600 });
  const chatHistory = withHistory ? new ChatHistory(root) : undefined;
  const agentState = withAgentState ? new AgentStateStore(root) : undefined;
  const liveVoices=liveRoleBindings&&speech?new LiveVoiceProfileStore(join(root,'live'),{workspace,bindings:liveRoleBindings,shares:liveShares}):undefined;
  const app = createService({ token, models, workspace, characters, liveVoices, ...(speech && {speech,liveProfile:new LiveProfileStore(join(root,'live'))}), ...(liveRoleBindings && {liveRoleBindings}), ...(liveShares && {liveShares}), chatHistory, agentState, chatRuntime: chatRuntime ?? undefined, runtime: { snapshot, probe: async () => snapshot(), close: async () => {} } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const created = await workspace.mutate('add', { expectedRevision: 0, package: pkg });
  assert.ok(created.ok);
  const petID = created.workspace.instances[0]!.id;
  if (liveRoleBindings) await liveRoleBindings.write(0, { longmei: petID, dafeiyu: null });
  const write = async (id: string, expectedRevision = 0, hasKey = true) => {
    assert.ok((await models.run('save', { connection: writeDraft(id), expectedRevision, credential: hasKey ? { kind: 'replace', key: `${key}-${id}` } : { kind: 'keep' } })).ok);
  };
  const defaultTo = async (connectionID: string, expectedRevision: number) => assert.ok((await models.run('default', { connectionID, entryID: 'entry-one', expectedRevision })).ok);
  const list = () => app.inject({ url: paths.list, headers });
  const send = async (route: object, fields: object = {}) => {
    const payload = { requestID: randomUUID(), petID, text: '聊聊纸船', history: [], route, ...(withHistory && { conversation: { id: randomUUID(), mode: 'new' } }), ...fields };
    let materialGrant: string | undefined;
    if ('attachments' in payload) {
      const permit = await app.inject({ method: 'POST', url: '/v1/chat/approve-materials', headers, payload });
      if (permit.statusCode === 200) materialGrant = permit.json().grant;
    }
    return app.inject({ method: 'POST', url: paths.send, headers, payload: { ...payload, ...(materialGrant && { materialGrant }) } });
  };
  const routes = async () => {
    const result = await list(); assert.equal(result.statusCode, 200);
    return result.json().models as { route: { connectionID: string; modelEntryID: string; fingerprint: string }; ready: boolean; isDefault: boolean }[];
  };
  const share = async () => {
    const added = await characters.apply(petID, 0, { type: 'addMemory', value: { kind: '事实', text: '蓝色纸船', source: '', citation: '', version: '' } });
    const id = added.state.memories[0]!.current.id;
    await characters.apply(petID, 1, { type: 'confirmMemory', id });
    await characters.apply(petID, 2, { type: 'setMemoryChatShare', id, enabled: true });
    return () => workspace.withRegisteredInstance(petID, registered => characters.apply(registered, 3, { type: 'setMemoryChatShare', id, enabled: false }));
  };
  return { app, root, petID, workspace, models, characters, liveVoices, historyFile, agentState, reads: () => reads, write, defaultTo, list, routes, send, share };
}

test('online chat returns reported input usage and the saved capacity without an extra provider call', use, async t => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    return Response.json({ ...await completion().json(), usage: calls === 1 ? { prompt_tokens: 151_000, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 120_000 } } : { completion_tokens: 2 } });
  });
  const draft = writeDraft('usage'); draft.models[0]!.contextWindow = 258_000;
  assert.ok((await f.models.run('save', { connection: draft, expectedRevision: 0, credential: { kind: 'keep' } })).ok);
  const option = (await f.list()).json().models[0];
  assert.equal(option.contextWindow, 258_000);
  assert.equal(calls, 0);
  const first = await f.send(option.route);
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json().usage, { inputTokens: 151_000 });
  assert.equal(calls, 1);
  const next = await f.send(option.route);
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(Object.hasOwn(next.json(), 'usage'), false);
  assert.equal(calls, 2);
});

test('fixed authenticated chat sends the visible destination and only authorized context, with no secret or endpoint in its list', use, async t => {
  const outbound: { url: string; headers: Headers; body: string }[] = [];
  const f = await fixture(t, async (url, init) => { outbound.push({ url: String(url), headers: new Headers(init?.headers), body: String(init?.body) }); return completion(); });
  await f.write('first'); await f.write('second'); await f.defaultTo('first', 2); await f.share();
  assert.equal((await f.app.inject({ url: paths.list, headers: { host: headers.host } })).statusCode, 401);
  const listing = await f.list(); assert.equal(listing.statusCode, 200);
  assert.doesNotMatch(listing.body, /https:|credentialRef|baseURL|SYNTHETIC|synthetic-model/);
  assert.equal(f.reads(), 0);
  const [, second] = await f.routes();
  assert.equal((await f.send(second!.route, { text: '查个人记忆：纸船' })).statusCode, 400);
  assert.equal((await f.send(second!.route, { headers: { authorization: 'forged' } })).statusCode, 400);
  const result = await f.send(second!.route); assert.equal(result.statusCode, 200);
  assert.equal(result.json().text, '合成回应'); assert.equal(result.json().replayable, false);
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0]!.url, 'https://second.invalid/v1/chat/completions');
  assert.equal(outbound[0]!.headers.get('authorization'), `Bearer ${key}-second`);
  const messages = JSON.parse(outbound[0]!.body).messages;
  assert.doesNotMatch(messages[0].content, /蓝色纸船/);
  assert.deepEqual(JSON.parse(messages.at(-1).content), { question: '聊聊纸船', characterContext: { personalMemories: ['蓝色纸船'] } });
});

test('online Responses chat consumes the terminal SSE reply from a stream-only saved gateway in one request', use, async t => {
  const outbound: { url: string; body: Record<string, unknown>; accept: string | null }[] = [];
  let cancelled = false;
  const f = await fixture(t, async (url, init) => {
    const body = JSON.parse(String(init?.body));
    outbound.push({ url: String(url), body, accept: new Headers(init?.headers).get('accept') });
    if (body.stream !== true) return Response.json({ status: 'failed', output: [] });
    const completed = { status: 'completed', output: [
      { type: 'reasoning' },
      { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '合成流回复' }] },
    ] };
    const frame = Buffer.from(`event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"不能发布这段增量"}\r\n\r\nevent: response.completed\r\ndata: ${JSON.stringify({ type: 'response.completed', response: completed })}\r\n\r\n`);
    return new Response(new ReadableStream({ start(controller) {
      // Split the UTF-8 terminal and deliberately leave the stream open after completion.
      const split = frame.indexOf(Buffer.from('合成流回复')) + 1;
      controller.enqueue(frame.subarray(0, split)); controller.enqueue(frame.subarray(split));
    }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  });
  const { revision, credentialRef, ...connection } = configuration('responses').connections[0]!;
  assert.ok((await f.models.run('save', { connection, expectedRevision: 0, credential: { kind: 'replace', key } })).ok);
  const [model] = await f.routes();
  const result = await f.send(model!.route);
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().text, '合成流回复');
  assert.equal(outbound.length, 1);
  const { body, accept, url } = outbound[0]!;
  assert.equal(url, `${connection.baseURL}/responses`);
  assert.match(accept ?? '', /text\/event-stream/);
  assert.equal(body.store, false);
  assert.equal(body.include, undefined);
  assert.equal(body.max_output_tokens, 2048);
  assert.equal(cancelled, true);
});

for (const transport of ['SSE', 'JSON']) test(`online Responses chat rejects an unfinished assistant message in a completed ${transport} envelope`, use, async t => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    const response = { status: 'completed', output: [
      { type: 'message', role: 'assistant', status: 'in_progress', content: [{ type: 'output_text', text: '不可保存的部分正文' }] },
    ] };
    return transport === 'JSON' ? Response.json(response) : new Response(
      `data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }, undefined, syntheticRuntime, true);
  const { revision, credentialRef, ...connection } = configuration('responses').connections[0]!;
  assert.ok((await f.models.run('save', { connection, expectedRevision: 0, credential: { kind: 'replace', key } })).ok);
  const [model] = await f.routes();
  const result = await f.send(model!.route);
  assert.equal(result.statusCode, 502, result.body);
  assert.deepEqual(result.json(), { ok: false, error: 'invalid_response' });
  const history = await f.app.inject({ method: 'POST', url: chatHistoryPaths.list, headers, payload: { petID: f.petID } });
  assert.deepEqual(history.json(), { ok: true, page: { rows: [], nextBefore: null } });
  assert.equal(calls, 1);
});

test('online Responses chat rejects a stream without a terminal event instead of publishing a delta or retrying', use, async t => {
  let calls = 0;
  const f = await fixture(t, async (_url, init) => {
    calls++;
    assert.equal(JSON.parse(String(init?.body)).stream, true);
    return new Response('data: {"type":"response.output_text.delta","delta":"未完成"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const { revision, credentialRef, ...connection } = configuration('responses').connections[0]!;
  assert.ok((await f.models.run('save', { connection, expectedRevision: 0, credential: { kind: 'replace', key } })).ok);
  const [model] = await f.routes();
  const result = await f.send(model!.route);
  assert.deepEqual(result.json(), { ok: false, error: 'invalid_response' });
  assert.equal(calls, 1);
});

test('image attachments require a saved Responses image-capable route before credentials or Provider calls', use, async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return completion(); });
  await f.write('images');
  const [saved] = await f.routes();
  const image = { name: 'diagram.png', mediaType: 'image/png', data: 'iVBORw0KGgoAAAAA' };
  const rejected = await f.send(saved!.route, { attachments: [image] });
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.json().error, 'invalid_request');
  assert.equal(f.reads(), 0);
  assert.equal(calls, 0);
});

test('Responses attachments are sent only in the active turn and never enter persisted chat text', use, async t => {
  const outbound: string[] = [];
  const f = await fixture(t, async (_url, init) => {
    outbound.push(String(init?.body));
    return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已读附件' }] }] });
  }, undefined, syntheticRuntime, true);
  const draft = writeDraft('responses');
  draft.apiProtocol = 'responses'; draft.models[0]!.inputModalities = ['image', 'pdf'];
  assert.equal((await f.models.run('save', { connection: draft, expectedRevision: 0, credential: { kind: 'replace', key: `${key}-responses` } })).ok, true);
  await f.defaultTo('responses', 1);
  const [saved] = await f.routes();
  const image = { name: 'diagram.png', mediaType: 'image/png', data: 'iVBORw0KGgoAAAAA' };
  const pdf = { name: 'guide.pdf', mediaType: 'application/pdf', data: 'JVBERi0xLjcK' };
  const conversation = { id: randomUUID(), mode: 'new' as const };
  const sent = await f.send(saved!.route, { conversation, attachments: [image, pdf] });
  assert.equal(sent.statusCode, 200);
  assert.equal(sent.json().replayable, false);
  assert.equal(outbound.length, 1);
  const body = JSON.parse(outbound[0]!);
  assert.equal(body.store, false);
  assert.deepEqual(body.input[0].content.slice(1), [
    { type: 'input_image', image_url: `data:image/png;base64,${image.data}` },
    { type: 'input_file', filename: 'guide.pdf', file_data: `data:application/pdf;base64,${pdf.data}` },
  ]);
  const history = await f.app.inject({ method: 'POST', url: chatHistoryPaths.detail, headers, payload: { petID: f.petID, id: conversation.id } });
  assert.equal(history.statusCode, 200);
  const savedDetail = history.json().detail;
  assert.equal(savedDetail.turns.length, 1);
  assert.equal(savedDetail.turns[0].user, '聊聊纸船');
  assert.equal(savedDetail.turns[0].assistant, '已读附件');
  assert.doesNotMatch(JSON.stringify(savedDetail), new RegExp(`${image.data}|${pdf.data}`));
  assert.doesNotMatch(outbound[0]!, /SYNTHETIC-CHAT-KEY/);
  const followup = await f.send(saved!.route, { conversation: { ...conversation, mode: 'resume' }, text: '新的问题' });
  assert.equal(followup.statusCode, 200);
  assert.deepEqual(JSON.parse(outbound[1]!).input, [{ role: 'user', content: [{ type: 'input_text', text: '新的问题' }] }]);
});

test('a new official Responses route accepts media picked by chat while an unknown compatible route stays text-only', use, async t => {
  let calls = 0;
  const f = await fixture(t, async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.input[0].content.map((item: { type: string }) => item.type), ['input_text', 'input_image', 'input_file']);
    return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已读附件' }] }] });
  });
  for (const id of ['known-media', 'proxy-media']) {
    const draft = writeDraft(id);
    draft.apiProtocol = 'responses'; draft.models[0]!.modelID = 'gpt-4.1';
    if (id === 'known-media') draft.baseURL = 'https://api.openai.com/v1';
    assert.ok((await f.models.run('save', { connection: draft, expectedRevision: 0, credential: { kind: 'keep' } })).ok);
  }
  const options = (await f.list()).json().models;
  const [known, proxy] = options;
  assert.deepEqual(known.inputModalities, ['image', 'pdf']);
  assert.equal(proxy.inputModalities, undefined);
  const attachments = [{ name: 'diagram.png', mediaType: 'image/png', data: 'iVBORw0KGgoAAAAA' },
    { name: 'guide.pdf', mediaType: 'application/pdf', data: 'JVBERi0xLjcK' }];
  assert.equal((await f.send(proxy.route, { attachments })).json().error, 'invalid_request');
  assert.equal(calls, 0);
  assert.equal((await f.send(known.route, { attachments })).statusCode, 200);
  assert.equal(calls, 1);
  assert.equal(f.reads(), 0);
});

test('a model without a Key is selectable and sends anonymously; a stale default still never sends', use, async t => {
  let calls = 0;
  const f = await fixture(t, async (url, init) => {
    calls++;
    assert.equal(url, 'https://missing.invalid/v1/chat/completions');
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    return completion();
  });
  await f.write('first'); await f.write('missing', 0, false);
  const [, missing] = await f.routes();
  assert.equal(missing!.ready, true);
  assert.equal((await f.send(missing!.route)).statusCode, 200);
  assert.equal(calls, 1); assert.equal(f.reads(), 0);
});

test('chat defaults to the earliest saved connection and its saved default entry, not the legacy override', use, async t => {
  const sent: string[] = [];
  const f = await fixture(t, async (url, options) => {
    sent.push(`${new URL(String(url)).hostname}/${JSON.parse(String(options?.body)).model}`);
    return completion();
  });
  const earliest = writeDraft('z-first');
  const alternate = { ...earliest.models[0]!, entryID: 'entry-alternate', modelID: 'preferred-api' };
  earliest.models.push(alternate);
  earliest.defaultModelEntryID = alternate.entryID;
  assert.ok((await f.models.run('save', { connection: earliest, expectedRevision: 0, credential: { kind: 'keep' } })).ok);
  await f.write('a-second', 0, false);
  const [other, first, second] = await f.routes();
  assert.deepEqual([other!.isDefault, first!.isDefault, second!.isDefault], [false, true, false]);
  const defaultRoute = { ...first!.route, useDefault: true };
  assert.equal((await f.send(defaultRoute)).statusCode, 200);
  await f.defaultTo('a-second', 2);
  assert.deepEqual((await f.routes()).map(item => item.isDefault), [false, true, false]);
  assert.equal((await f.send(defaultRoute)).statusCode, 200);
  assert.equal((await f.send(second!.route)).statusCode, 200, 'explicit per-chat choice remains available');
  assert.ok((await f.models.run('remove', { connectionID: 'z-first', expectedRevision: 1 })).ok);
  assert.equal((await f.send(defaultRoute)).json().error, 'route_changed');
  assert.deepEqual((await f.routes()).filter(item => item.isDefault).map(item => item.route.connectionID), ['a-second']);
  assert.equal((await f.send({ ...second!.route, useDefault: true })).statusCode, 200);
  assert.deepEqual(sent, ['z-first.invalid/preferred-api', 'z-first.invalid/preferred-api', ...Array(2).fill(`a-second.invalid/${earliest.models[0]!.modelID}`)]);
});

test('withdrawal during credential read is reflected before the request leaves', use, async t => {
  const entered = deferred<void>(), release = deferred<void>();
  let sent = '';
  const f = await fixture(t, async (_url, init) => { sent = String(init?.body); return completion(); }, async () => { entered.resolve(); await release.promise; });
  await f.write('first'); const [first] = await f.routes(); const withdraw = await f.share();
  const pending = f.send(first!.route);
  await entered.promise; try { await withdraw(); } finally { release.resolve(); }
  assert.equal((await pending).json().replayable, true);
  assert.ok(sent.includes('聊聊纸船')); assert.ok(!sent.includes('蓝色纸船'));
});

test('Key rotation during read and role deletion during transport never return a stale result', use, async t => {
  const reading = deferred<void>(), releaseKey = deferred<void>();
  const dispatched = deferred<void>(), releaseReply = deferred<void>();
  let calls = 0;
  const f = await fixture(t, async () => { calls++; dispatched.resolve(); await releaseReply.promise; return completion(); }, async () => { reading.resolve(); await releaseKey.promise; });
  await f.write('first'); const [first] = await f.routes(); const pending = f.send(first!.route);
  await reading.promise; try { await f.write('first', 1); } finally { releaseKey.resolve(); }
  assert.equal((await pending).json().error, 'route_changed'); assert.equal(calls, 0);
  const [rotated] = await f.routes(); const current = f.send(rotated!.route);
  await dispatched.promise;
  try { assert.ok((await f.workspace.mutate('delete', { expectedRevision: 1, id: f.petID })).ok); } finally { releaseReply.resolve(); }
  assert.equal((await current).json().error, 'not_found'); assert.equal(calls, 1);
});

test('a provider reflecting the active synthetic Key does not put it in the reply', use, async t => {
  const f = await fixture(t, async () => completion(`here: ${key}-first`));
  await f.write('first'); const [first] = await f.routes();
  const response = await f.send(first!.route);
  assert.equal(response.json().error, 'invalid_response'); assert.ok(!response.body.includes(key));
});

test('withdrawing authorization while a contextual request is in flight discards its late reply', use, async t => {
  const entered = deferred<void>(), release = deferred<void>();
  const f = await fixture(t, async () => { entered.resolve(); await release.promise; return completion('蓝色纸船'); });
  await f.write('first'); const [first] = await f.routes(); const withdraw = await f.share();
  const pending = f.send(first!.route);
  await entered.promise; try { await withdraw(); } finally { release.resolve(); }
  const response = await pending;
  assert.deepEqual(response.json(), { ok: false, error: 'context_changed' });
});

test('final chat publication is ordered with consent withdrawal while the ledger is settling', use, async t => {
  const finishing = deferred<void>(), publish = deferred<void>();
  const f = await fixture(t, async () => completion('蓝色纸船'), undefined, createPiTextRuntime(), true, true);
  await f.write('first'); const [saved] = await f.routes(); const withdraw = await f.share();
  const ledger = f.agentState!;
  const finish = ledger.finish.bind(ledger);
  ledger.finish = async (...args) => {
    if (args[1] === 'completed') { finishing.resolve(); await publish.promise; }
    return finish(...args);
  };
  const pending = f.send(saved!.route);
  await Promise.race([finishing.promise, pending.then(() => assert.fail('ledger was not reached'))]);
  let withdrawn = false;
  const revoke = withdraw().then(() => { withdrawn = true; });
  try { await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(withdrawn, false, 'revocation must be ordered after the in-progress authorized commit'); }
  finally { publish.resolve(); await revoke; }
  assert.equal((await pending).statusCode, 200);
});

test('model rotation is ordered after a terminal publication already holding its route', use, async t => {
  const finishing = deferred<void>(), publish = deferred<void>();
  const f = await fixture(t, async () => completion(), undefined, createPiTextRuntime(), true, true);
  await f.write('first'); const [saved] = await f.routes();
  const ledger = f.agentState!, finish = ledger.finish.bind(ledger);
  ledger.finish = async (...args) => {
    if (args[1] === 'completed') { finishing.resolve(); await publish.promise; }
    return finish(...args);
  };
  const pending = f.send(saved!.route);
  await Promise.race([finishing.promise, pending.then(() => assert.fail('ledger was not reached'))]);
  let rotated = false;
  const rotate = f.write('first', 1, false).then(() => { rotated = true; });
  try { await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(rotated, false, 'a route mutation must not overtake the authorized commit'); }
  finally { publish.resolve(); await Promise.all([rotate, pending]); }
  assert.equal((await pending).statusCode, 200);
});

test('aborting the trusted loopback request reaches the provider signal and suppresses a late reply', { ...use, timeout: 10_000 }, async t => {
  const entered = deferred<void>(), aborted = deferred<void>(), release = deferred<void>();
  const f = await fixture(t, async (_url, init) => {
    init!.signal!.addEventListener('abort', () => aborted.resolve());
    entered.resolve(); await release.promise; return completion();
  }, undefined, syntheticRuntime, true);
  await f.write('first'); const [first] = await f.routes();
  await f.app.listen({ host: '127.0.0.1', port: 0 });
  const address = f.app.server.address(); assert.ok(address && typeof address === 'object');
  const session = { port: address.port, token };
  const { requestChatHistory, requestChatModels, requestOnlineChat } = await import('../../desktop/src/chat-transport.ts');
  const listed = await requestChatModels(session);
  assert.ok(listed.ok && listed.models.length === 1);
  const controller = new AbortController();
  const sent = requestOnlineChat(session, { requestID: randomUUID(), petID: f.petID, route: first!.route, text: '合成问题', history: [], conversation: { id: randomUUID(), mode: 'new' } }, controller.signal);
  try {
    await entered.promise; controller.abort();
    assert.deepEqual(await sent, { ok: false, error: 'cancelled' }); await aborted.promise;
  } finally { release.resolve(); }
  assert.deepEqual(await requestChatHistory(session, 'list', { petID: f.petID }), { ok: true, page: { rows: [], nextBefore: null } });
});

test('cancelling during a pending credential read prevents the first provider call', use, async t => {
  const entered = deferred<void>(), release = deferred<void>();
  let calls = 0, reads = 0;
  const f = await fixture(t, async () => { calls++; return completion(); }, async () => { if (++reads === 1) { entered.resolve(); await release.promise; } });
  await f.write('first'); const [first] = await f.routes();
  const controller = new AbortController();
  const turns = new TextChatTurns(syntheticRuntime);
  const input = { requestID: randomUUID(), petID: f.petID, route: first!.route, text: '合成问题', history: [] };
  const sent = sendOnlineChat(f.models, f.workspace, f.characters, input, controller.signal, turns);
  await entered.promise;
  try {
    controller.abort();
    assert.deepEqual(await sent, { ok: false, error: 'cancelled' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(await sendOnlineChat(f.models, f.workspace, f.characters, { ...input, requestID: randomUUID() }, new AbortController().signal, turns), { ok: false, error: 'busy' });
  } finally { release.resolve(); await turns.close(); }
  // Let the pending vault read finish; the cancelled request must remain unable to dispatch.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
});

const useRuntime = { ...use, timeout: 5_000 };

async function runtimeFixture(t: test.TestContext, transport: typeof globalThis.fetch, runtime: TextChatRuntime, beforeRead?: () => Promise<void>) {
  const f = await fixture(t, transport, beforeRead, runtime);
  await f.write('first');
  const [model] = await f.routes();
  return { ...f, route: model!.route, turn: (fields = {}) => f.send(model!.route, { requestID: randomUUID(), ...fields }) };
}

test('injected runtime owns the chat terminal; only a bound provider request carries saved history and consent', useRuntime, async t => {
  const sent: { url: string; headers: Headers; body: string }[] = [];
  const consumed = deferred<void>(), finish = deferred<void>();
  const f = await runtimeFixture(t, async (url, init) => {
    sent.push({ url: String(url), headers: new Headers(init?.headers), body: String(init?.body) });
    return completion('运行时未预知的回复');
  }, async (text, complete) => {
    assert.equal(text, '聊聊纸船');
    assert.equal(sent.length, 0);
    await assert.rejects(complete('改写内容'), { message: 'invalid_request' });
    const response = complete(text);
    await assert.rejects(complete(text), { message: 'invalid_request' });
    const reply = await response;
    assert.equal(reply, '运行时未预知的回复');
    consumed.resolve(); await finish.promise;
    return reply;
  });
  await f.share();
  const requestID = randomUUID();
  const pending = f.turn({ requestID, history: [{ user: '既往私有问题', assistant: '既往私有答复' }] });
  try {
    await Promise.race([consumed.promise, pending.then(() => assert.fail('chat returned before the runtime terminal'))]);
    assert.deepEqual((await f.turn()).json(), { ok: false, error: 'busy' });
  } finally { finish.resolve(); }
  assert.deepEqual((await pending).json(), { ok: true, requestID, text: '运行时未预知的回复', replayable: false });
  assert.deepEqual((await f.turn({ requestID })).json(), { ok: false, error: 'invalid_request' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, 'https://first.invalid/v1/chat/completions');
  assert.equal(sent[0]!.headers.get('authorization'), `Bearer ${key}-first`);
  const body = JSON.parse(sent[0]!.body);
  assert.equal(body.model, 'synthetic-model'); assert.equal(body.tools, undefined);
  assert.deepEqual(body.messages.slice(-3, -1), [{ role: 'user', content: '既往私有问题' }, { role: 'assistant', content: '既往私有答复' }]);
  assert.deepEqual(JSON.parse(body.messages.at(-1).content), { question: '聊聊纸船', characterContext: { personalMemories: ['蓝色纸船'] } });
});

for (const kind of ['unclaimed', 'forged', 'worker-exit', 'provider-lost'] as const) test(`runtime ${kind} does not publish or fall back to direct generation`, useRuntime, async t => {
  let calls = 0, late: (() => Promise<string>) | undefined;
  const aborted = deferred<void>();
  const f = await runtimeFixture(t, async (_url, init) => {
    calls++;
    if (kind === 'provider-lost') throw new Error('PRIVATE-TRANSPORT-DETAIL');
    if (kind === 'worker-exit') return new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => { aborted.resolve(); reject(new Error('aborted')); }, { once: true });
      entered.resolve();
    });
    return completion();
  }, async (text, complete) => {
    late = () => complete(text);
    if (kind === 'unclaimed') return '合成回应';
    if (kind === 'worker-exit') {
      void complete(text).catch(() => {});
      await entered.promise;
      throw new Error('PRIVATE-WORKER-DETAIL');
    }
    const textFromProvider = await complete(text);
    return `${textFromProvider}（篡改）`;
  });
  const entered = deferred<void>();
  const requestID = randomUUID();
  const result = (await f.turn({ requestID })).json();
  assert.deepEqual(result, { ok: false, error: kind === 'unclaimed' || kind === 'forged' ? 'invalid_response' : 'upstream_unavailable' });
  if (kind === 'worker-exit') await aborted.promise;
  await assert.rejects(late!(), { message: 'invalid_request' });
  assert.deepEqual((await f.turn({ requestID })).json(), { ok: false, error: 'invalid_request' });
  assert.equal(calls, kind === 'unclaimed' ? 0 : 1);
});

test('the runtime rechecks sharing after the provider reply and before publishing', useRuntime, async t => {
  let withdraw!: () => Promise<unknown>;
  const f = await runtimeFixture(t, async () => completion('蓝色纸船'), async (text, complete) => {
    const reply = await complete(text);
    await withdraw();
    return reply;
  });
  withdraw = await f.share();
  assert.deepEqual((await f.turn()).json(), { ok: false, error: 'context_changed' });
});

test('the saved route cannot rotate between runtime launch and provider admission', useRuntime, async t => {
  let rotate!: () => Promise<unknown>;
  const f = await runtimeFixture(t, async () => assert.fail('stale route must not dispatch'), async (text, complete) => {
    await rotate(); return complete(text);
  });
  rotate = () => f.write('first', 1);
  assert.deepEqual((await f.turn()).json(), { ok: false, error: 'route_changed' });
  assert.equal(f.reads(), 0);
});

test('another pet can run concurrently without receiving the first pet’s authorized context', useRuntime, async t => {
  const first = deferred<void>(), release = deferred<void>();
  const outbound: string[] = [];
  const f = await runtimeFixture(t, async (_url, init) => { outbound.push(String(init?.body)); return completion(); }, async (text, complete) => {
    if (text === '聊聊纸船') { first.resolve(); await release.promise; }
    return complete(text);
  });
  await f.share();
  const created = await f.workspace.mutate('add', { expectedRevision: 1, package: { id: 'local.pet', version: '1.0.0' } });
  assert.ok(created.ok);
  const other = created.workspace.instances.find(instance => instance.id !== f.petID)!.id;
  const a = f.turn();
  try {
    await Promise.race([first.promise, a.then(() => assert.fail('first runtime missing'))]);
    assert.equal((await f.turn({ petID: other, text: '另一只桌宠' })).json().ok, true);
  } finally { release.resolve(); }
  assert.equal((await a).json().ok, true);
  assert.equal(outbound.length, 2);
  assert.doesNotMatch(outbound[0]!, /蓝色纸船/);
  assert.match(outbound[1]!, /蓝色纸船/);
});

test('a cancelled turn revokes provider admission before the vault is opened and retains its slot through worker cleanup', useRuntime, async t => {
  const f = await fixture(t, async () => assert.fail('cancelled turn must not dispatch'));
  await f.write('first'); const [first] = await f.routes();
  const entered = deferred<() => Promise<string>>(), release = deferred<void>();
  const turns = new TextChatTurns(async (text, complete, signal) => {
    entered.resolve(() => complete(text));
    await release.promise;
    assert(signal.aborted);
    return '晚到回复';
  });
  const stop = new AbortController();
  const input = { requestID: randomUUID(), petID: f.petID, route: first!.route, text: '聊聊纸船', history: [] };
  const send = (value = input, signal = AbortSignal.timeout(1000)) => sendOnlineChat(f.models, f.workspace, f.characters, value, signal, turns);
  const pending = send(input, stop.signal);
  try {
    const complete = await Promise.race([entered.promise, pending.then(() => assert.fail('runtime not started'))]);
    stop.abort();
    assert.deepEqual(await pending, { ok: false, error: 'cancelled' });
    await assert.rejects(complete(), { message: 'invalid_request' });
    assert.deepEqual(await send(), { ok: false, error: 'invalid_request' });
    assert.deepEqual(await send({ ...input, requestID: randomUUID() }), { ok: false, error: 'busy' });
    assert.equal(f.reads(), 0);
  } finally { release.resolve(); turns.close(); }
});

test('provider truncation is not a successful Agent model response', useRuntime, async t => {
  const f = await runtimeFixture(t, async () => Response.json({ choices: [{ message: { role: 'assistant', content: '被截断' }, finish_reason: 'length' }] }),
    (text, complete) => complete(text));
  assert.deepEqual((await f.turn()).json(), { ok: false, error: 'invalid_response' });
});

test('Pi runs a literal text turn through the fixed chat route without forwarding its envelope', useRuntime, async t => {
  const text = '/help\n聊聊纸船';
  const answer = `模型生成后才知道：${randomUUID()}`;
  let sent = 0;
  const f = await runtimeFixture(t, async (url, init) => {
    sent++;
    assert.equal(url, 'https://first.invalid/v1/chat/completions');
    const { model, tools, messages } = JSON.parse(String(init?.body));
    assert.equal(model, 'synthetic-model'); assert.equal(tools, undefined);
    assert.deepEqual(JSON.parse(messages.at(-1).content), { question: text, characterContext: { personalMemories: ['蓝色纸船'] } });
    assert.doesNotMatch(String(init?.body), /system-reminder|pet-harness/);
    return completion(answer);
  }, createPiTextRuntime());
  await f.share();
  const requestID = randomUUID();
  assert.deepEqual((await f.turn({ requestID, text })).json(), { ok: true, requestID, text: answer, replayable: false });
  assert.deepEqual((await f.turn({ requestID, text })).json(), { ok: false, error: 'invalid_request' });
  assert.equal(sent, 1);
});

test('ordinary identity questions reach the selected Pi-backed model without pulling unrelated memories', useRuntime, async t => {
  let sent = 0;
  const f = await runtimeFixture(t, async (_url, init) => {
    sent++;
    assert.equal(JSON.parse(String(init?.body)).messages.at(-1).content, '你是谁？');
    return completion('我是合成桌宠。');
  }, createPiTextRuntime());
  await f.share();
  const result = await f.turn({ text: '你是谁？' });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().text, '我是合成桌宠。');
  assert.equal(sent, 1);
});

test('closing the service stops a Pi turn and aborts the pending provider', useRuntime, async t => {
  const dispatched = deferred<void>(), cancelled = deferred<void>();
  const f = await runtimeFixture(t, async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => { cancelled.resolve(); reject(new Error('synthetic abort')); }, { once: true });
    dispatched.resolve();
  }), createPiTextRuntime());
  const turn = f.turn();
  await Promise.race([dispatched.promise, turn.then(() => assert.fail('provider was not reached'))]);
  await f.app.close();
  await cancelled.promise;
  assert.equal((await turn).json().ok, false);
});


test('the fixed chat handler without a configured Runtime cannot invoke the Provider', use, async t => {
  const f = await fixture(t, async () => assert.fail('a missing Runtime must not dispatch'), undefined, null);
  await f.write('first');
  const [first] = await f.routes();
  assert.deepEqual((await f.send(first!.route)).json(), { ok: false, error: 'unavailable' });
  assert.equal(f.reads(), 0);
});

test('a slash-only message is submitted as a literal Pi prompt', useRuntime, async t => {
  const f = await runtimeFixture(t, async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).messages.at(-1).content, '/help');
    return completion('合成字面正文回应');
  }, createPiTextRuntime());
  const result = (await f.turn({ text: '/help' })).json();
  assert.equal(result.text, '合成字面正文回应');
});

test('cancellation during final verification keeps the same pet slot until verification drains', useRuntime, async () => {
  const turns = new TextChatTurns(syntheticRuntime);
  const rechecking = deferred<void>(), release = deferred<void>();
  const input = { requestID: randomUUID(), petID: 'test-pet', route: { connectionID: 'synthetic', modelEntryID: 'synthetic', fingerprint: 'f'.repeat(64) }, text: '合成正文', history: [] };
  const owner = new AbortController();
  const pending = turns.run(input, async () => '合成回答', owner.signal, {
    after: async () => { rechecking.resolve(); await release.promise; },
  });
  try {
    await Promise.race([rechecking.promise, pending.then(() => assert.fail('final verification was not awaited'))]);
    owner.abort();
    await assert.rejects(pending, { message: 'cancelled' });
    await assert.rejects(turns.run({ ...input, requestID: randomUUID() }, async () => '合成回答', new AbortController().signal), { message: 'busy' });
  } finally { release.resolve(); await turns.close(); }
});

test('a Worker failure revokes but does not release a pet slot before its admitted Provider settles', useRuntime, async () => {
  const dispatched = deferred<void>(), release = deferred<void>();
  const turns = new TextChatTurns(async (text, complete) => {
    void complete(text).catch(() => {});
    await dispatched.promise;
    throw new Error('synthetic Worker died');
  });
  const input = { requestID: randomUUID(), petID: 'test-pet', route: { connectionID: 'synthetic', modelEntryID: 'synthetic', fingerprint: 'e'.repeat(64) }, text: '合成正文', history: [] };
  const signal = new AbortController().signal;
  try {
    await assert.rejects(turns.run(input, async owned => {
      dispatched.resolve(); await release.promise;
      assert.ok(owned.aborted);
      return '晚到的合成回答';
    }, signal), { message: 'upstream_unavailable' });
    await assert.rejects(turns.run({ ...input, requestID: randomUUID() }, async () => assert.fail('slot was released'), signal), { message: 'busy' });
  } finally { release.resolve(); await turns.close(); }
});


test('authenticated history saves only a verified terminal, gates clearing, and denies a retired pet', use, async t => {
  const consumed = deferred<void>(), finish = deferred<void>();
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return completion(); }, undefined, async (text, complete) => {
    const response = await complete(text);
    consumed.resolve(); await finish.promise;
    return response;
  }, true);
  await f.write('first'); const [first] = await f.routes();
  const history = (method: keyof typeof chatHistoryPaths, payload: object, auth = headers) => f.app.inject({ method: 'POST', url: chatHistoryPaths[method], headers: auth, payload });
  assert.equal((await history('list', { petID: f.petID }, { host: headers.host, authorization: 'forged' })).statusCode, 401);
  for (const text of ['查个人记忆：纸船', '记住：纸船']) assert.equal((await f.send(first!.route, { text })).statusCode, 400);
  const requestID = randomUUID();
  const conversation = { id: randomUUID(), mode: 'new' };
  const pending = f.send(first!.route, { requestID, conversation });
  try {
    await consumed.promise;
    assert.deepEqual((await history('list', { petID: f.petID })).json(), { ok: true, page: { rows: [], nextBefore: null } });
    assert.equal((await history('clear', { petID: f.petID, confirmed: true })).statusCode, 409);
  } finally { finish.resolve(); }
  assert.equal((await pending).statusCode, 200);
  assert.equal((await f.send(first!.route, { requestID })).statusCode, 400);
  assert.equal(calls, 1);
  assert.equal((await history('clear', { petID: f.petID })).statusCode, 400);
  const rows = (await history('list', { petID: f.petID })).json().page.rows;
  assert.deepEqual(rows, [{ id: conversation.id, number: 1, completedAt: rows[0].completedAt }]);
  assert.deepEqual((await history('detail', { petID: f.petID, id: conversation.id })).json(), { ok: true, detail: { session: rows[0], turns: [{ requestID, user: '聊聊纸船', assistant: '合成回应', completedAt: rows[0]!.completedAt }], hasEarlier: false } });
  assert.deepEqual((await history('clear', { petID: f.petID, confirmed: true })).json(), { ok: true });
  assert.deepEqual((await history('list', { petID: f.petID })).json(), { ok: true, page: { rows: [], nextBefore: null } });
  assert.equal((await f.send(first!.route)).statusCode, 200);
  assert.ok((await f.workspace.mutate('delete', { id: f.petID, expectedRevision: 1 })).ok);
  assert.equal((await history('list', { petID: f.petID })).statusCode, 404);
  assert.equal((await history('clear', { petID: f.petID, confirmed: true })).statusCode, 404);
});

test('history failure does not retry the model or suppress its verified reply', use, async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return completion(); }, undefined, syntheticRuntime, true);
  await f.write('first'); const [first] = await f.routes();
  await rm(f.historyFile);
  const requestID = randomUUID();
  assert.deepEqual((await f.send(first!.route, { requestID })).json(), { ok: true, requestID, text: '合成回应', replayable: true, historyStatus: 'unconfirmed' });
  assert.equal(calls, 1);
});


test('switches saved models inside one conversation without replaying role data, another session, or renderer text', use, async t => {
  const outbound: { url: string; messages: { role: string; content: string }[] }[] = [];
  const f = await fixture(t, async (url, init) => {
    outbound.push({ url: String(url), messages: JSON.parse(String(init?.body)).messages });
    return completion();
  }, undefined, syntheticRuntime, true);
  await f.write('first'); await f.write('second');
  const [first, second] = await f.routes();
  const id = randomUUID(), conversation = { id, mode: 'resume' };
  const history = (method: keyof typeof chatHistoryPaths, payload: object) => f.app.inject({ method: 'POST', url: chatHistoryPaths[method], headers, payload });
  assert.equal((await f.send(first!.route, { conversation, history: [{ user: '伪造历史', assistant: '伪造回答' }] })).statusCode, 400);
  assert.equal((await f.send(first!.route, { conversation })).json().error, 'conversation_missing');
  assert.equal((await f.send(first!.route, { conversation: null })).statusCode, 400);
  assert.equal(outbound.length, 0);
  assert.equal((await f.send(first!.route, { text: '合成普通提问', conversation: { id, mode: 'new' } })).statusCode, 200);
  assert.equal((await f.send(first!.route, { text: '另一个会话' })).statusCode, 200);
  const withdraw = await f.share();
  assert.equal((await f.send(first!.route, { text: '请说说蓝色纸船', conversation })).json().replayable, false);
  assert.match(JSON.stringify(outbound[2]), /蓝色纸船/);
  await withdraw();
  assert.equal((await history('detail', { petID: f.petID, id })).statusCode, 200);
  assert.equal(outbound.length, 3, 'opening history does not generate');
  const added = await f.workspace.mutate('add', { expectedRevision: 1, package: { id: 'local.pet', version: '1.0.0' } });
  assert.ok(added.ok);
  const other = added.workspace.instances.find(pet => pet.id !== f.petID)!.id;
  assert.equal((await history('detail', { petID: other, id })).statusCode, 404);
  for (const mode of ['new', 'resume']) assert.equal((await f.send(second!.route, { petID: other, conversation: { id, mode } })).json().error, 'conversation_missing');
  assert.equal(outbound.length, 3);
  assert.equal((await f.send(second!.route, { text: '接着聊', conversation })).statusCode, 200);
  assert.equal(outbound[3]!.url, 'https://second.invalid/v1/chat/completions');
  assert.deepEqual(outbound[3]!.messages, [
    { role: 'user', content: '合成普通提问' }, { role: 'assistant', content: '合成回应' }, { role: 'user', content: '接着聊' },
  ]);
  assert.deepEqual((await history('list', { petID: f.petID })).json().page.rows.map((row: { id: string }) => row.id).slice(0, 1), [id]);
  assert.equal((await history('detail', { petID: f.petID, id })).json().detail.turns.length, 3);
  assert.equal((await history('clear', { petID: f.petID, confirmed: true })).statusCode, 200);
  assert.equal((await f.send(second!.route, { conversation })).json().error, 'conversation_missing');
  assert.equal(outbound.length, 4);
});

test('retry of a completed logical turn recovers the saved answer without dispatching or appending again', use, async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return Response.json({ ...await completion().json(), usage: { prompt_tokens: 68 } }); }, undefined, syntheticRuntime, true);
  await f.write('first'); const [first] = await f.routes();
  const id = randomUUID(), turnID = randomUUID(), conversation = { id, mode: 'new' };
  const firstReply = await f.send(first!.route, { conversation, turnID });
  assert.equal(firstReply.statusCode, 200);
  assert.deepEqual(firstReply.json().usage, { inputTokens: 68 });
  const requestID = randomUUID();
  assert.deepEqual((await f.send(first!.route, { requestID, conversation, turnID })).json(), { ok: true, requestID, text: '合成回应', replayable: true, recovered: true });
  assert.equal((await f.send(first!.route, { conversation, turnID, text: '不是原问题' })).json().error, 'invalid_request');
  const other = { id: randomUUID(), mode: 'new' };
  assert.equal((await f.send(first!.route, { conversation: other, turnID })).json().error, 'invalid_request');
  assert.equal(calls, 1);
  const res = await f.app.inject({ method: 'POST', url: chatHistoryPaths.detail, headers, payload: { petID: f.petID, id } });
  assert.equal(res.statusCode, 200);
  assert.equal(Object.hasOwn(res.json().detail.turns[0], 'usage'), false);
  assert.deepEqual(res.json().detail.turns.map((row: { requestID: string }) => row.requestID), [turnID]);
});

test('recovery is local even if the resend route changes; a missing saved reply may go to the explicit new model', use, async t => {
  const providerCalls: string[] = [];
  const f = await fixture(t, async url => { providerCalls.push(new URL(String(url)).hostname); return completion(); }, undefined, syntheticRuntime, true);
  await f.write('first'); await f.write('second');
  const [first, second] = await f.routes();
  const turnID = randomUUID(), id = randomUUID();
  assert.equal((await f.send(first!.route, { requestID: turnID, turnID, conversation: { id, mode: 'new' } })).statusCode, 200);
  const conversation = { id, mode: 'resume' }, requestID = randomUUID();
  const recovered = await f.send(second!.route, { requestID, turnID, conversation });
  assert.deepEqual(recovered.json(), { ok: true, requestID, text: '合成回应', replayable: true, recovered: true });
  assert.deepEqual(providerCalls, ['first.invalid']);
  assert.equal(f.reads(), 1);
  const staleRoute = { ...second!.route, fingerprint: 'f'.repeat(64) };
  const stale = await f.send(staleRoute, { turnID, conversation });
  assert.equal(stale.json().recovered, true, 'local access is not tied to the availability of a provider route');
  const missing = await f.send(second!.route, { turnID: randomUUID(), text: '未保存的上一轮', conversation });
  assert.equal(missing.statusCode, 200);
  assert.equal(missing.json().recovered, undefined);
  assert.deepEqual(providerCalls, ['first.invalid', 'second.invalid']);
  const res = await f.app.inject({ method: 'POST', url: chatHistoryPaths.detail, headers, payload: { petID: f.petID, id } });
  assert.equal(res.json().detail.turns.length, 2);
});

test('trusted loopback reads older messages without opening a credential or invoking a provider', use, async t => {
  let providerCalls = 0;
  const f = await fixture(t, async () => { providerCalls++; return completion(); }, undefined, syntheticRuntime, true);
  await f.write('first'); const [first] = await f.routes();
  const id = randomUUID();
  for (let i = 1; i <= 7; i++) {
    const result = await f.send(first!.route, { text: `合成第 ${i} 问`, conversation: { id, mode: i === 1 ? 'new' : 'resume' } });
    assert.equal(result.statusCode, 200);
  }
  const readsBefore = f.reads();
  await f.app.listen({ host: '127.0.0.1', port: 0 });
  const address = f.app.server.address(); assert.ok(address && typeof address === 'object');
  const { requestChatHistory } = await import('../../desktop/src/chat-transport.ts');
  const session = { port: address.port, token }, input = { petID: f.petID, id };
  const latest = await requestChatHistory(session, 'detail', input);
  assert.ok(isHistoryDetailResult(latest, id) && latest.ok && latest.detail.hasEarlier);
  const before = latest.detail.turns[0]!.requestID;
  const earlier = await requestChatHistory(session, 'detail', { ...input, before });
  assert.ok(isHistoryDetailResult(earlier, id, before) && earlier.ok && !earlier.detail.hasEarlier);
  assert.deepEqual(earlier.detail.turns.map(turn => turn.user), ['合成第 1 问']);
  assert.deepEqual(await requestChatHistory(session, 'detail', { ...input, before: randomUUID() }), { ok: false, error: 'not_found' });
  assert.equal(f.reads(), readsBefore);
  assert.equal(providerCalls, 7);
});

test('material permission is one-use and bound to exact request before model dispatch', use, async t => {
  const outbound: string[] = [];
  const f = await fixture(t, async (_url, init) => {
    outbound.push(String(init?.body));
    const tool = (name: string, args: string) => Response.json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'call-one', type: 'function', function: { name, arguments: args } }] } }] });
    if (outbound.length === 1) return tool('read_task_file', '{"file":1,"offset":0}');
    return completion();
  });
  await f.write('first');
  const [saved] = await f.routes();
  const input = { requestID: randomUUID(), petID: f.petID, text: '整理本次材料', history: [], route: saved!.route,
    attachments: [{ name: 'notes.txt', mediaType: 'text/plain', data: '5L2g5aW9' }] };
  const send = (payload: object) => f.app.inject({ method: 'POST', url: paths.send, headers, payload });
  assert.equal((await send(input)).json().error, 'approval_required');
  assert.equal(outbound.length, 0);
  const approval = await f.app.inject({ method: 'POST', url: '/v1/chat/approve-materials', headers, payload: input });
  assert.equal(approval.statusCode, 200);
  const replacement = await f.app.inject({ method: 'POST', url: '/v1/chat/approve-materials', headers, payload: input });
  assert.equal(replacement.statusCode, 200);
  assert.notEqual(approval.json().grant, replacement.json().grant);
  assert.equal((await send({ ...input, materialGrant: approval.json().grant })).json().error, 'approval_required');
  const { grant } = replacement.json();
  assert.equal((await send({ ...input, text: '不同的指令', materialGrant: grant })).json().error, 'approval_required');
  const granted = await send({ ...input, materialGrant: grant });
  assert.equal(granted.statusCode, 200, granted.body);
  assert.equal((await send({ ...input, materialGrant: grant })).json().error, 'approval_required');
  assert.equal(outbound.length, 2);
  assert.match(outbound[0]!, /整理本次材料/);
  assert.doesNotMatch(outbound[0]!, /verify_task_tools|notes.txt|你好/);
  assert.match(outbound[1]!, /你好/);
});

for (const finalInput of [350, undefined]) test(`mixed Responses streaming reports only the last material round usage (${finalInput})`, use, async t => {
  const outbound: Record<string, any>[] = [];
  const f = await fixture(t, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); outbound.push(body);
    if (body.stream !== true) return new Response(null, { status: 400 });
    const output = outbound.length === 1 ? [
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque-sealed-data', summary: [] },
      { type: 'function_call', id: 'fc_1', call_id: 'call-one', name: 'read_task_file', arguments: '{"file":1,"offset":0}' },
    ] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已处理本轮材料' }] }];
    return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output, usage: { input_tokens: outbound.length === 1 ? 120 : finalInput, output_tokens: 20 } } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }, undefined, createPiTextRuntime());
  const draft = writeDraft('mixed'); draft.apiProtocol = 'responses'; draft.models[0]!.inputModalities = ['image'];
  assert.ok((await f.models.run('save', { connection: draft, expectedRevision: 0, credential: { kind: 'keep' } })).ok);
  const [saved] = await f.routes();
  const image = { name: 'diagram.png', mediaType: 'image/png', data: 'iVBORw0KGgoAAAAA' };
  const text = (value: string) => ({ name: 'private-name.txt', mediaType: 'text/plain', data: Buffer.from(value).toString('base64') });
  const rejected = await f.send(saved!.route, { attachments: [image, text('password policy')] });
  assert.equal(rejected.statusCode, 400, rejected.body);
  assert.equal(outbound.length, 0);
  const sent = await f.send(saved!.route, { attachments: [image, text('你好' + '另'.repeat(600))] });
  assert.equal(sent.statusCode, 200, sent.body);
  assert.deepEqual(sent.json().usage, finalInput === undefined ? undefined : { inputTokens: finalInput });
  assert.equal(outbound.length, 2);
  assert.deepEqual(outbound[0]!.input[0].content.map(({ type }: { type: string }) => type), ['input_text', 'input_image']);
  assert.doesNotMatch(JSON.stringify(outbound), /private-name|另{421}|verify_task_tools/);
  assert.doesNotMatch(JSON.stringify(outbound[0]), /你好/);
  assert.match(JSON.stringify(outbound[1]), /你好/);
  assert.ok(outbound[1]!.input.some(({ type, encrypted_content }: { type: string; encrypted_content?: string }) => type === 'reasoning' && encrypted_content === 'opaque-sealed-data'));
});

test('project registration and chat scope stay local; unknown projects never dispatch', use, async t => {
 const outbound: string[] = [];
 const f = await fixture(t, async (_url, init) => { outbound.push(String(init?.body)); return completion(); }, undefined, syntheticRuntime, true);
 await f.write('first'); const [first] = await f.routes();
 const project = { id: randomUUID(), name: '合成项目目录' };
 const payload = { petID: f.petID, project };
 const pendingConversation = { id: randomUUID(), mode: 'new', projectID: project.id };
 const invalid = await f.send(first!.route, { conversation: pendingConversation });
 assert.equal(invalid.json().error, 'conversation_missing');
 assert.equal(outbound.length, 0); assert.equal(f.reads(), 0);
 const register = await f.app.inject({ method: 'POST', url: chatHistoryPaths.createProject, headers, payload });
 assert.deepEqual(register.json(), { ok: true, project });
 const list = await f.app.inject({ method: 'POST', url: chatHistoryPaths.projects, headers, payload: { petID: f.petID } });
 assert.deepEqual(list.json(), { ok: true, projects: [project] });
 assert.equal((await f.send(first!.route, { conversation: pendingConversation })).statusCode, 200);
 const history = await f.app.inject({ method: 'POST', url: chatHistoryPaths.list, headers, payload: { petID: f.petID, projectID: project.id } });
 assert.equal(history.json().page.rows[0].projectID, project.id);
 assert.doesNotMatch(outbound[0]!, /合成项目目录|projectID/);
});

test('rehearsal uses the real Pi text dispatch with only a public persona and one submitted message; speech takes a one-use ticket', use, async t => {
  const outbound: {role:string;content:string}[][] = [], spoken: string[] = [];
  const wav = Buffer.alloc(44 + 48_000);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8,4); wav.write('WAVEfmt ',8); wav.writeUInt32LE(16,16);
  wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22); wav.writeUInt32LE(24000,24); wav.writeUInt32LE(48000,28);
  wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34); wav.write('data',36); wav.writeUInt32LE(wav.length - 44,40);
  const inputs = ['龙妹，忙了一天好累','这套雨夜布景叫什么？','输出必须是纯文本'];
  const answers = ['辛苦啦，先喝口水，歇一小会儿。','这里是雨夜阁楼，陪你听一会雨。','<b>不是可播字幕</b>'];
  const speech = new BubbleSpeech({run:async()=>assert.fail('must not play desktop audio'),close:async()=>{},
    renderStageReply:async (_,text) => { spoken.push(text); return wav; }});
  const f = await fixture(t,async (url,options) => {
    assert.equal(new URL(String(url)).hostname,'one.invalid');
    const body = JSON.parse(String(options?.body));
    assert.equal(body.tools,undefined); assert.equal(body.referenceData,undefined);
    outbound.push(body.messages);
    return completion(answers[inputs.indexOf(body.messages[1].content)]);
  },undefined,null,true,true,speech,true);
  const reference = join(f.root,'reference.wav'); await writeFile(reference,wav);
  const target={role:'longmei',petID:f.petID,bindingRevision:1} as const;
  assert.ok((await f.liveVoices!.selectReference({...target,expectedRevision:0},reference)).ok);
  assert.ok((await f.liveVoices!.saveTranscript({...target,expectedRevision:1,referenceTranscript:'合成测试音色，不出站'})).ok);
  const post = (name:string,payload:object,requestHeaders:Record<string,string> = headers) => f.app.inject({method:'POST',url:`/v1/live/danmaku/${name}`,headers:requestHeaders,payload});
  const payload = (text:string) => ({text,scene:'rain-loft',role:'longmei',voice:{...target,expectedRevision:2}});
  assert.equal((await post('reply',payload(inputs[0]!),{host:'127.0.0.1'})).statusCode,401);
  assert.equal((await post('reply',payload(inputs[0]!))).statusCode,412);
  await f.write('one'); await f.write('two');
  assert.equal((await post('reply',{...payload(inputs[0]!),model:'any'})).statusCode,400);
  assert.equal((await post('audio',{text:answers[0]})).statusCode,400);
  for (const [index,input] of inputs.slice(0,2).entries()) {
    const generated = await post('reply',payload(input)); assert.equal(generated.statusCode,200);
    const {ticket,text} = generated.json(); assert.equal(text,answers[index]);
    const rendered = await post('audio',{ticket}); assert.equal(rendered.statusCode,200); assert.deepEqual(rendered.rawPayload,wav);
    assert.equal((await post('audio',{ticket})).statusCode,409);
  }
  await f.defaultTo('two',2); // Old configuration metadata must not redirect rehearsal.
  assert.equal((await post('reply',payload(inputs[2]!))).statusCode,503);
  assert.deepEqual(spoken,answers.slice(0,2));
  for (const [index,messages] of outbound.entries()) {
    assert.deepEqual(messages.map(m=>m.role),['system','user']);
    assert.match(messages[0]!.content,/龙妹.*雨夜阁楼/s);
    assert.doesNotMatch(messages[0]!.content,/合成测试音色|合成桌宠|SYNTHETIC/);
    assert.equal(messages[1]!.content,inputs[index]);
  }
  const superseded = await post('reply',payload(inputs[0]!)); assert.equal(superseded.statusCode,200);
  const fifth = await post('reply',payload(inputs[0]!)); assert.equal(fifth.statusCode,200);
  assert.equal((await post('audio',{ticket:superseded.json().ticket})).statusCode,409);
  const pending = await post('reply',payload(inputs[0]!)); assert.equal(pending.statusCode,200);
  assert.equal((await post('reply',payload(inputs[0]!))).statusCode,429);
  assert.ok((await f.models.run('remove', { connectionID: 'one', expectedRevision: 1 })).ok);
  assert.equal((await post('audio',{ticket:pending.json().ticket})).statusCode,503);
  assert.deepEqual(spoken,answers.slice(0,2));
  assert.ok((await f.workspace.mutate('pause',{expectedRevision:1})).ok);
  assert.equal((await post('reply',payload(inputs[0]!))).statusCode,409);
  assert.equal(outbound.length,6);
});

test('live identity withdrawal during real credential read prevents all provider dispatch', use, async t => {
  const reading=deferred<void>(),release=deferred<void>();let armed=false,calls=0;
  const speech=new BubbleSpeech({run:async()=>assert.fail('must not play audio'),close:async()=>{}});
  const f=await fixture(t,async()=>{calls++;return completion('欢迎来到直播间！');},async()=>{if(armed){reading.resolve();await release.promise;}},null,false,false,speech,true);
  await f.characters.apply(f.petID,0,{type:'saveIdentity',value:{name:'合成龙妹',role:'待撤回的合成身份',background:'',personality:'活泼',values:'',motivations:'',relationship:'',speakingStyle:'简洁',knowledgeScope:'',boundaries:'不泄露资料'}});
  await f.write('one');
  const post=(url:string,payload:object)=>f.app.inject({method:'POST',url,headers,payload});
  const scope={role:'longmei',petID:f.petID,bindingRevision:1} as const;
  assert.equal((await post('/v1/live/shares',{...scope,expectedRevision:0,records:[{kind:'identity',recordID:'identity',recordRevision:1}]})).statusCode,200);
  const wav=Buffer.alloc(44+48000);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
  const reference = join(f.root,'independent.wav');await writeFile(reference,wav);
  assert.ok((await f.liveVoices!.selectReference({...scope,expectedRevision:0},reference)).ok);
  assert.ok((await f.liveVoices!.saveTranscript({...scope,expectedRevision:1,referenceTranscript:'合成逐字稿'})).ok);
  armed=true;
  const pending=post('/v1/live/danmaku/reply',{role:'longmei',scene:'desk-room',text:'你好',voice:{...scope,expectedRevision:2}}).then(r=>r);
  await reading.promise;
  try{assert.equal((await post('/v1/live/shares',{...scope,expectedRevision:1,records:[]})).statusCode,200);}
  finally{release.resolve();}
  assert.notEqual((await pending).statusCode,200);
  assert.equal(calls,0,'the real ModelClient fetch must not observe withdrawn identity');
});
