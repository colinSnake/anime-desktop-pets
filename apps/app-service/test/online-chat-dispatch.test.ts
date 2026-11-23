import { fileURLToPath } from 'node:url';
import { createHarnessRuntime } from '../src/agent/harness-runtime.ts';
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
import { createService } from '../src/server.ts';
import { sendOnlineChat } from '../src/online-chat.ts';
import { TextChatTurns, type TextChatRuntime } from '../src/agent/text-chat-runtime.ts';
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
async function fixture(t: test.TestContext, fetch: typeof globalThis.fetch, beforeRead?: () => Promise<void>, chatRuntime: TextChatRuntime | null = syntheticRuntime, withHistory = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pet-online-chat-')));
  const { backend } = syntheticVault(); let reads = 0;
  const models = new ModelManagement(join(root, 'models'), { ...backend, read: async (...args) => { reads++; await beforeRead?.(); return backend.read(...args); } }, undefined, { fetch });
  const pkg = { id: 'local.pet', version: '1.0.0' };
  const workspace = new PetWorkspace({ root, catalog: [{ ...pkg, name: '合成桌宠' }] });
  const characters = new CharacterRepository(join(root, 'characters'));
  const snapshot = () => ({ kind: 'diagnostic' as const, status: 'idle' as const, detail: '' });
  const historyFile = join(root, 'chats.sqlite');
  if (withHistory) await writeFile(historyFile, '', { mode: 0o600 });
  const chatHistory = withHistory ? new ChatHistory(root) : undefined;
  const app = createService({ token, models, workspace, characters, chatHistory, chatRuntime: chatRuntime ?? undefined, runtime: { snapshot, probe: async () => snapshot(), close: async () => {} } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const created = await workspace.mutate('add', { expectedRevision: 0, package: pkg });
  assert.ok(created.ok);
  const petID = created.workspace.instances[0]!.id;
  const write = async (id: string, expectedRevision = 0, hasKey = true) => {
    assert.ok((await models.run('save', { connection: writeDraft(id), expectedRevision, credential: hasKey ? { kind: 'replace', key: `${key}-${id}` } : { kind: 'keep' } })).ok);
  };
  const defaultTo = async (connectionID: string, expectedRevision: number) => assert.ok((await models.run('default', { connectionID, entryID: 'entry-one', expectedRevision })).ok);
  const list = () => app.inject({ url: paths.list, headers });
  const send = (route: object, fields: object = {}) => app.inject({ method: 'POST', url: paths.send, headers,
    payload: { requestID: randomUUID(), petID, text: '聊聊纸船', history: [], route, ...(withHistory && { conversation: { id: randomUUID(), mode: 'new' } }), ...fields } });
  const routes = async () => {
    const result = await list(); assert.equal(result.statusCode, 200);
    return result.json().models as { route: { connectionID: string; modelEntryID: string; fingerprint: string }; ready: boolean }[];
  };
  const share = async () => {
    const added = await characters.apply(petID, 0, { type: 'addMemory', value: { kind: '事实', text: '蓝色纸船', source: '', citation: '', version: '' } });
    const id = added.state.memories[0]!.current.id;
    await characters.apply(petID, 1, { type: 'confirmMemory', id });
    await characters.apply(petID, 2, { type: 'setMemoryChatShare', id, enabled: true });
    return () => workspace.withRegisteredInstance(petID, registered => characters.apply(registered, 3, { type: 'setMemoryChatShare', id, enabled: false }));
  };
  return { app, petID, workspace, models, characters, historyFile, reads: () => reads, write, defaultTo, list, routes, send, share };
}

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

test('missing Key or a stale displayed default never reads another credential or sends', use, async t => {
  const f = await fixture(t, async () => assert.fail('must not send'));
  await f.write('first'); await f.write('missing', 0, false); await f.defaultTo('first', 2);
  const [first, missing] = await f.routes();
  assert.equal(missing!.ready, false);
  assert.equal((await f.send(missing!.route)).json().error, 'credentials_unavailable');
  await f.defaultTo('missing', 3);
  assert.equal((await f.send({ ...first!.route, useDefault: true })).json().error, 'route_changed');
  assert.equal(f.reads(), 0);
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
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return completion(); }, async () => { entered.resolve(); await release.promise; });
  await f.write('first'); const [first] = await f.routes();
  const controller = new AbortController();
  const sent = sendOnlineChat(f.models, f.workspace, f.characters, { requestID: randomUUID(), petID: f.petID, route: first!.route, text: '合成问题', history: [] }, controller.signal, new TextChatTurns(syntheticRuntime));
  await entered.promise;
  try {
    controller.abort();
    assert.deepEqual(await sent, { ok: false, error: 'cancelled' });
  } finally { release.resolve(); }
  // Let the pending vault read finish; the cancelled request must remain unable to dispatch.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
});

const useHarness = { ...use, timeout: 5_000 };

async function harnessFixture(t: test.TestContext, transport: typeof globalThis.fetch, runtime: TextChatRuntime, beforeRead?: () => Promise<void>) {
  const f = await fixture(t, transport, beforeRead, runtime);
  await f.write('first');
  const [model] = await f.routes();
  return { ...f, route: model!.route, turn: (fields = {}) => f.send(model!.route, { requestID: randomUUID(), ...fields }) };
}

test('injected runtime owns the chat terminal; only a bound provider request carries saved history and consent', useHarness, async t => {
  const sent: { url: string; headers: Headers; body: string }[] = [];
  const consumed = deferred<void>(), finish = deferred<void>();
  const f = await harnessFixture(t, async (url, init) => {
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

for (const kind of ['unclaimed', 'forged', 'worker-exit', 'provider-lost'] as const) test(`runtime ${kind} does not publish or fall back to direct generation`, useHarness, async t => {
  let calls = 0, late: (() => Promise<string>) | undefined;
  const aborted = deferred<void>();
  const f = await harnessFixture(t, async (_url, init) => {
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

test('the runtime rechecks sharing after the provider reply and before publishing', useHarness, async t => {
  let withdraw!: () => Promise<unknown>;
  const f = await harnessFixture(t, async () => completion('蓝色纸船'), async (text, complete) => {
    const reply = await complete(text);
    await withdraw();
    return reply;
  });
  withdraw = await f.share();
  assert.deepEqual((await f.turn()).json(), { ok: false, error: 'context_changed' });
});

test('the saved route cannot rotate between runtime launch and provider admission', useHarness, async t => {
  let rotate!: () => Promise<unknown>;
  const f = await harnessFixture(t, async () => assert.fail('stale route must not dispatch'), async (text, complete) => {
    await rotate(); return complete(text);
  });
  rotate = () => f.write('first', 1);
  assert.deepEqual((await f.turn()).json(), { ok: false, error: 'route_changed' });
  assert.equal(f.reads(), 0);
});

test('another pet can run concurrently without receiving the first pet’s authorized context', useHarness, async t => {
  const first = deferred<void>(), release = deferred<void>();
  const outbound: string[] = [];
  const f = await harnessFixture(t, async (_url, init) => { outbound.push(String(init?.body)); return completion(); }, async (text, complete) => {
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

test('a cancelled turn revokes provider admission before the vault is opened and retains its slot through worker cleanup', useHarness, async t => {
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

test('provider truncation is not a successful harness model response', useHarness, async t => {
  const f = await harnessFixture(t, async () => Response.json({ choices: [{ message: { role: 'assistant', content: '被截断' }, finish_reason: 'length' }] }),
    (text, complete) => complete(text));
  assert.deepEqual((await f.turn()).json(), { ok: false, error: 'invalid_response' });
});

const useSDK = { skip: process.platform !== 'darwin', timeout: 25_000 };
const sdkWorker = fileURLToPath(new URL('../src/agent/harness-worker.mjs', import.meta.url));

test('the installed SDK runs a literal text turn through the fixed chat route without forwarding its envelope', useSDK, async t => {
  const text = '/help\n聊聊纸船';
  const answer = `模型生成后才知道：${randomUUID()}`;
  let sent = 0;
  const f = await harnessFixture(t, async (url, init) => {
    sent++;
    assert.equal(url, 'https://first.invalid/v1/chat/completions');
    const { model, tools, messages } = JSON.parse(String(init?.body));
    assert.equal(model, 'synthetic-model'); assert.equal(tools, undefined);
    assert.deepEqual(JSON.parse(messages.at(-1).content), { question: text, characterContext: { personalMemories: ['蓝色纸船'] } });
    assert.doesNotMatch(String(init?.body), /system-reminder|pet-harness/);
    return completion(answer);
  }, createHarnessRuntime({ worker: sdkWorker }));
  await f.share();
  const requestID = randomUUID();
  assert.deepEqual((await f.turn({ requestID, text })).json(), { ok: true, requestID, text: answer, replayable: false });
  assert.deepEqual((await f.turn({ requestID, text })).json(), { ok: false, error: 'invalid_request' });
  assert.equal(sent, 1);
});

test('missing SDK worker never reads the selected Key or falls back', useSDK, async t => {
  const f = await harnessFixture(t, async () => assert.fail('must not invoke the model'), createHarnessRuntime({ worker: `${sdkWorker}.missing` }));
  assert.deepEqual((await f.turn()).json(), { ok: false, error: 'unavailable' });
  assert.equal(f.reads(), 0);
});

test('closing the service stops a real SDK turn and aborts the pending provider', useSDK, async t => {
  const dispatched = deferred<void>(), cancelled = deferred<void>();
  const f = await harnessFixture(t, async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => { cancelled.resolve(); reject(new Error('synthetic abort')); }, { once: true });
    dispatched.resolve();
  }), createHarnessRuntime({ worker: sdkWorker }));
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

test('a slash-only message is submitted as a literal SDK prompt', useSDK, async t => {
  const f = await harnessFixture(t, async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).messages.at(-1).content, '/help');
    return completion('合成字面正文回应');
  }, createHarnessRuntime({ worker: sdkWorker }));
  const result = (await f.turn({ text: '/help' })).json();
  assert.equal(result.text, '合成字面正文回应');
});

test('cancellation during final verification keeps the same pet slot until verification drains', useHarness, async () => {
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

test('a Worker failure revokes but does not release a pet slot before its admitted Provider settles', useHarness, async () => {
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
  const f = await fixture(t, async () => { calls++; return completion(); }, undefined, syntheticRuntime, true);
  await f.write('first'); const [first] = await f.routes();
  const id = randomUUID(), turnID = randomUUID(), conversation = { id, mode: 'new' };
  assert.equal((await f.send(first!.route, { conversation, turnID })).statusCode, 200);
  const requestID = randomUUID();
  assert.deepEqual((await f.send(first!.route, { requestID, conversation, turnID })).json(), { ok: true, requestID, text: '合成回应', replayable: true, recovered: true });
  assert.equal((await f.send(first!.route, { conversation, turnID, text: '不是原问题' })).json().error, 'invalid_request');
  const other = { id: randomUUID(), mode: 'new' };
  assert.equal((await f.send(first!.route, { conversation: other, turnID })).json().error, 'invalid_request');
  assert.equal(calls, 1);
  const res = await f.app.inject({ method: 'POST', url: chatHistoryPaths.detail, headers, payload: { petID: f.petID, id } });
  assert.equal(res.statusCode, 200);
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
