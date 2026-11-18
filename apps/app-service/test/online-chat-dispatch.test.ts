import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ModelManagement } from '../src/models/management.ts';
import { PetWorkspace } from '../src/pet-workspace.ts';
import { CharacterRepository } from '../src/characters/repository.ts';
import { createService } from '../src/server.ts';
import { sendOnlineChat } from '../src/online-chat.ts';
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
async function fixture(t: test.TestContext, fetch: typeof globalThis.fetch, beforeRead?: () => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pet-online-chat-')));
  const { backend } = syntheticVault(); let reads = 0;
  const models = new ModelManagement(join(root, 'models'), { ...backend, read: async (...args) => { reads++; await beforeRead?.(); return backend.read(...args); } }, undefined, { fetch });
  const pkg = { id: 'local.pet', version: '1.0.0' };
  const workspace = new PetWorkspace({ root, catalog: [{ ...pkg, name: '合成桌宠' }] });
  const characters = new CharacterRepository(join(root, 'characters'));
  const snapshot = () => ({ kind: 'diagnostic' as const, status: 'idle' as const, detail: '' });
  const app = createService({ token, models, workspace, characters, runtime: { snapshot, probe: async () => snapshot(), close: async () => {} } });
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
    payload: { requestID: '0f000000-0000-4000-8000-000000000001', petID, text: '聊聊纸船', history: [], route, ...fields } });
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
  return { app, petID, workspace, models, characters, reads: () => reads, write, defaultTo, list, routes, send, share };
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

test('aborting the trusted loopback request reaches the provider signal and suppresses a late reply', use, async t => {
  const entered = deferred<void>(), aborted = deferred<void>(), release = deferred<void>();
  const f = await fixture(t, async (_url, init) => {
    init!.signal!.addEventListener('abort', () => aborted.resolve());
    entered.resolve(); await release.promise; return completion();
  });
  await f.write('first'); const [first] = await f.routes();
  await f.app.listen({ host: '127.0.0.1', port: 0 });
  const address = f.app.server.address(); assert.ok(address && typeof address === 'object');
  const session = { port: address.port, token };
  const { requestChatModels, requestOnlineChat } = await import('../../desktop/src/chat-transport.ts');
  const listed = await requestChatModels(session);
  assert.ok(listed.ok && listed.models.length === 1);
  const controller = new AbortController();
  const sent = requestOnlineChat(session, { requestID: randomUUID(), petID: f.petID, route: first!.route, text: '合成问题', history: [] }, controller.signal);
  try {
    await entered.promise; controller.abort();
    assert.deepEqual(await sent, { ok: false, error: 'cancelled' }); await aborted.promise;
  } finally { release.resolve(); }
});

test('cancelling during a pending credential read prevents the first provider call', use, async t => {
  const entered = deferred<void>(), release = deferred<void>();
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return completion(); }, async () => { entered.resolve(); await release.promise; });
  await f.write('first'); const [first] = await f.routes();
  const controller = new AbortController();
  const sent = sendOnlineChat(f.models, f.workspace, f.characters, { requestID: randomUUID(), petID: f.petID, route: first!.route, text: '合成问题', history: [] }, controller.signal);
  await entered.promise;
  try {
    controller.abort();
    assert.deepEqual(await sent, { ok: false, error: 'cancelled' });
  } finally { release.resolve(); }
  // Let the pending vault read finish; the cancelled request must remain unable to dispatch.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
});
