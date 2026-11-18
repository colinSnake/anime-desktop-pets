import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ModelManagement } from '../src/models/management.ts';
import { createService } from '../src/server.ts';
import { MODEL_PROTOCOLS, type ModelProtocol } from '../src/models/types.ts';
import { configuration } from './fixtures/models.ts';
import { syntheticVault } from './fixtures/secure-models.ts';
import { textReply } from './fixtures/model-replies.ts';

const local = { skip: process.platform === 'win32' };
const headers = { host: '127.0.0.1', authorization: `Bearer ${'a'.repeat(64)}` };
const input = { connectionID: 'probe', expectedRevision: 2, entryID: 'draft-entry', modelID: 'draft-model', maxOutputTokens: 24 };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t: TestContext, fetch: typeof globalThis.fetch, beforeRead?: () => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'model-probe-')));
  const { backend } = syntheticVault(); let reads = 0;
  const models = new ModelManagement(root, { ...backend, read: async (...args) => { reads++; await beforeRead?.(); return backend.read(...args); } }, undefined, { fetch });
  const snapshot = () => ({ kind: 'diagnostic' as const, status: 'idle' as const, detail: '' });
  const app = createService({ token: 'a'.repeat(64), models, runtime: { snapshot, probe: async () => snapshot(), close: async () => {} } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const save = async (id: string, protocol: ModelProtocol, expectedRevision = 0, hasKey = true) => {
    const { revision, credentialRef, ...draft } = configuration(protocol).connections[0]!;
    assert.ok((await models.run('save', { connection: { ...draft, id, baseURL: `https://${id}.invalid/prefix/${protocol === 'gemini' ? 'v1beta' : 'v1'}` }, expectedRevision, credential: hasKey ? { kind: 'replace', key: `SYNTHETIC-KEY-${id}` } : { kind: 'keep' } })).ok);
  };
  const post = (payload: object, auth = headers) => app.inject({ method: 'POST', url: '/v1/models/test', headers: auth, payload });
  await save('other', 'chat-completions');
  return { app, post, save, models, reads: () => reads };
}
for (const protocol of MODEL_PROTOCOLS) test(`${protocol}: tests only the chosen saved destination and current draft model, without saving or relaying provider content`, local, async t => {
  let call: { url: string; headers: Headers; body: { model?: string; max_tokens?: number; max_output_tokens?: number; generationConfig?: { maxOutputTokens: number }; tools?: unknown } } | undefined;
  const f = await fixture(t, async (url, init) => {
    assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error'); assert.equal(call, undefined);
    call = { url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
    return Response.json(textReply(protocol));
  });
  await f.save('probe', protocol); const before = await f.models.run('list', undefined);
  const reply = await f.post({ ...input, ...(protocol === 'chat-completions' ? { outputTokenField: 'max_tokens' } : {}) });
  assert.equal(reply.statusCode, 200, reply.body);
  assert.deepEqual(reply.json(), { version: 1, ok: true, connectionID: 'probe', revision: 2, entryID: 'draft-entry' });
  assert.deepEqual(await f.models.run('list', undefined), before);
  assert.match(call!.url, /^https:\/\/probe\.invalid\/prefix\/v1/);
  assert.equal(call!.headers.get(protocol === 'anthropic' ? 'x-api-key' : protocol === 'gemini' ? 'x-goog-api-key' : 'authorization'), `${protocol === 'anthropic' || protocol === 'gemini' ? '' : 'Bearer '}SYNTHETIC-KEY-probe`);
  assert.equal(protocol === 'gemini' ? call!.url.split('/').at(-1) : call!.body.model, protocol === 'gemini' ? 'draft-model:generateContent' : 'draft-model');
  assert.equal(call!.body.max_tokens ?? call!.body.max_output_tokens ?? call!.body.generationConfig?.maxOutputTokens, 24);
  assert.match(JSON.stringify(call!.body), /Reply with OK\./); assert.equal(call!.body.tools, undefined); assert.equal(f.reads(), 1);
});

test('missing key, unexpected fields and stale revision cannot access a credential or provider', local, async t => {
  const f = await fixture(t, async () => assert.fail('unexpected provider call'));
  await f.save('probe', 'chat-completions', 0, false);
  assert.equal((await f.post(input, { ...headers, authorization: '' })).statusCode, 401);
  for (const fields of [{ baseURL: 'https://other.invalid' }, { credentialRef: 'arbitrary' }, { text: 'not a probe' }, { headers: {} }]) assert.equal((await f.post({ ...input, ...fields })).statusCode, 400);
  assert.equal((await f.post({ ...input, expectedRevision: 1 })).json().error, 'configuration_conflict');
  assert.equal((await f.post(input)).json().error, 'credentials_unavailable'); assert.equal(f.reads(), 0);
});

test('replacing the selected Key while its old version is pending cancels before dispatch', local, async t => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const f = await fixture(t, async () => { calls++; return Response.json(textReply('chat-completions')); }, async () => { entered.resolve(); await release.promise; });
  await f.save('probe', 'chat-completions');
  const pending = f.post(input).then(value => value);
  await entered.promise; try { await f.save('probe', 'chat-completions', 2); } finally { release.resolve(); }
  assert.equal((await pending).json().error, 'cancelled'); assert.equal(calls, 0);
});

test('refused generation is not a passed test and raw errors stay private', local, async t => {
  const f = await fixture(t, async () => Response.json({ choices: [{ message: { role: 'assistant', content: 'PRIVATE-FIXTURE' }, finish_reason: 'content_filter' }] }));
  await f.save('probe', 'chat-completions'); const result = await f.post(input);
  assert.equal(result.json().error, 'invalid_response'); assert.doesNotMatch(result.body, /PRIVATE-FIXTURE/);
});

test('trusted loopback cancellation aborts an in-flight probe and cannot return a late success', local, async t => {
  const entered = deferred(), aborted = deferred(), release = deferred();
  const f = await fixture(t, async (_url, init) => {
    init!.signal!.addEventListener('abort', aborted.resolve, { once: true });
    entered.resolve(); await release.promise;
    return Response.json(textReply('chat-completions'));
  });
  await f.save('probe', 'chat-completions');
  await f.app.listen({ host: '127.0.0.1', port: 0 });
  const address = f.app.server.address(); assert.ok(address && typeof address === 'object');
  const { requestModelProbe } = await import('../../desktop/src/model-transport.ts');
  const controller = new AbortController();
  const pending = requestModelProbe({ port: address.port, token: 'a'.repeat(64) }, input, controller.signal);
  try {
    await entered.promise;
    assert.equal((await f.models.discover({ connectionID: 'other', expectedRevision: 1 })).ok, false);
    controller.abort();
    assert.deepEqual(await pending, { version: 1, ok: false, error: 'cancelled' });
    await aborted.promise;
  } finally { release.resolve(); }
});
