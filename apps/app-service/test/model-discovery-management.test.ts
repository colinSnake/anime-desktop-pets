import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ModelManagement } from '../src/models/management.ts';
import { createService } from '../src/server.ts';
import { configuration } from './fixtures/models.ts';
import { syntheticVault } from './fixtures/secure-models.ts';
import type { ModelProtocol } from '../src/models/types.ts';

const use = { skip: process.platform === 'win32' };
const auth = { host: '127.0.0.1', authorization: `Bearer ${'a'.repeat(64)}` };
const path = '/v1/models/discover';
const secret = 'SYNTHETIC-LIST-KEY';
const savedDraft = (apiProtocol: ModelProtocol = 'responses') => {
  const { revision: _r, credentialRef: _c, ...draft } = configuration().connections[0]!;
  return { ...draft, apiProtocol, baseURL: `https://synthetic.invalid/gateway/${apiProtocol === 'gemini' ? 'v1beta' : 'v1'}`, compatibility: {}, models: draft.models.map(m => ({ ...m, compatibility: {} })) };
};
async function fixture(t: test.TestContext, fetch: typeof globalThis.fetch, beforeRead?: () => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pet-discovery-')));
  const { backend, items } = syntheticVault(); let reads = 0;
  const models = new ModelManagement(root, { ...backend, read: async (...args) => { reads++; await beforeRead?.(); return backend.read(...args); } }, undefined, { fetch });
  const snapshot = () => ({ kind: 'diagnostic' as const, status: 'idle' as const, detail: '' });
  const app = createService({ token: 'a'.repeat(64), models, runtime: { snapshot, probe: async () => snapshot(), close: async () => {} } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const write = async (protocol?: ModelProtocol, expectedRevision = 0, key = true) => {
    const connection = savedDraft(protocol);
    const result = await models.run('save', { connection, expectedRevision, credential: key ? { kind: 'replace', key: secret } : { kind: 'keep' } });
    assert.equal(result.ok, true); return { connectionID: connection.id, expectedRevision: expectedRevision + 1 };
  };
  return { app, models, items, reads: () => reads, write, post: (payload: object) => app.inject({ method: 'POST', url: path, headers: auth, payload }) };
}
for (const [protocol, suffix, header, value, body] of [
  ['chat-completions', '/models', 'authorization', `Bearer ${secret}`, { data: [{ id: 'example' }], has_more: true }],
  ['responses', '/models', 'authorization', `Bearer ${secret}`, { data: [{ id: 'example' }], has_more: true }],
  ['anthropic', '/models?limit=100', 'x-api-key', secret, { data: [{ id: 'example' }], has_more: true, last_id: 'next-token' }],
  ['gemini', '/models?pageSize=100', 'x-goog-api-key', secret, { models: [{ name: 'models/example', supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'next-token' }],
] as const) test(`saved ${protocol} discovery uses only the adapter's first page and never commits candidates`, use, async t => {
  let calls = 0;
  const f = await fixture(t, async (url, init) => {
    calls++; assert.equal(url, `${savedDraft(protocol).baseURL}${suffix}`); assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error'); assert.equal(init?.body, undefined); assert.equal(new Headers(init?.headers).get(header), value);
    return Response.json(body);
  });
  const payload = await f.write(protocol);
  const result = await f.post(payload);
  assert.equal(result.statusCode, 200); assert.deepEqual(result.json(), { version: 1, ok: true, connectionID: payload.connectionID, revision: 1, candidates: [{ modelID: 'example', displayName: 'example' }], truncated: true });
  assert.equal(calls, 1); assert.equal(f.reads(), 1);
  const list = await f.models.run('list', undefined);
  assert.equal(list.ok && list.configuration.revision, 1); assert.equal(list.ok && list.configuration.connections[0]?.models.some(m => m.modelID === 'example'), false);
});

test('unauthenticated, extra fields and stale revisions are rejected before credential access', use, async t => {
  const f = await fixture(t, async () => assert.fail('must not send'));
  const input = await f.write('responses', 0, false);
  const noAuth = await f.app.inject({ method: 'POST', url: path, headers: { host: auth.host }, payload: input });
  assert.equal(noAuth.statusCode, 401);
  for (const fields of [{ key: secret }, { baseURL: 'https://other.invalid' }, { headers: {} }, { cursor: 'next' }]) assert.equal((await f.post({ ...input, ...fields })).statusCode, 400);
  assert.equal((await f.post({ ...input, expectedRevision: 2 })).json().error, 'configuration_conflict');
  assert.equal(f.reads(), 0);
});

test('discovery without a Key sends no authentication header and returns provider feedback', use, async t => {
  let calls = 0;
  const f = await fixture(t, async (url, init) => {
    assert.equal(url, `${savedDraft('anthropic').baseURL}/models?limit=100`);
    assert.equal(new Headers(init?.headers).has('x-api-key'), false);
    return ++calls === 1 ? Response.json({ data: [{ id: 'example' }] }) : new Response('private provider details', { status: 401 });
  });
  const input = await f.write('anthropic', 0, false);
  assert.equal((await f.post(input)).json().ok, true);
  assert.deepEqual((await f.post(input)).json(), { version: 1, ok: false, error: 'authentication_failed' });
  assert.equal(calls, 2); assert.equal(f.reads(), 0);
});

test('credentials reflected in candidate metadata and unsafe IDs never reach the UI', use, async t => {
  let id = `x-${secret}`;
  const f = await fixture(t, async () => Response.json({ data: [{ id }] }));
  const input = await f.write();
  for (const candidate of [`x-${secret}`, `x-${[...f.items.keys()][0]}`, 'model with spaces', 'model\u202eSpoof']) {
    id = candidate;
    const result = await f.post(input);
    assert.equal(result.json().error, 'invalid_response'); assert.doesNotMatch(result.body, /SYNTHETIC|Spoof/);
  }
});

test('deleting a connection aborts an in-flight list; late provider success cannot return candidates', use, async t => {
  let entered!: () => void, finish!: (reply: Response) => void, signal: AbortSignal | undefined | null;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(t, async (_url, init) => { signal = init?.signal; entered(); return new Promise(resolve => { finish = resolve; }); });
  const input = await f.write();
  const pending = f.models.discover(input);
  await started;
  assert.equal((await f.models.discover(input)).ok, false);
  assert.equal((await f.models.run('remove', input)).ok, true);
  assert.equal(signal?.aborted, true);
  finish(Response.json({ data: [{ id: 'late' }] }));
  const result = await pending; assert.equal(result.ok, false); assert.equal(!result.ok && result.error, 'cancelled');
});

test('a caller disconnecting from the authenticated loopback route cancels upstream', { ...use, timeout: 4000 }, async t => {
  let entered!: () => void, ended!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const cancelled = new Promise<void>(resolve => { ended = resolve; });
  const f = await fixture(t, async (_url, options) => {
    options?.signal?.addEventListener('abort', ended, { once: true }); entered();
    return new Promise(() => {});
  });
  const input = await f.write(), address = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const controller = new AbortController(); t.after(() => controller.abort());
  const pending = fetch(`${address}${path}`, { method: 'POST', signal: controller.signal, headers: { authorization: auth.authorization, 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await started; controller.abort();
  await rejected; await cancelled;
});


test('discovery reads only the selected saved connection and never sends a rotated Key under the old revision', use, async t => {
  const attempts: [string, string | null][] = [];
  const f = await fixture(t, async (url, init) => { attempts.push([String(url), new Headers(init?.headers).get('authorization')]); return Response.json({ data: [] }); });
  const a = await f.write();
  const second = { ...savedDraft(), id: 'other-account', baseURL: 'https://second.synthetic.invalid/private/v1' };
  const b = await f.models.run('save', { connection: second, expectedRevision: 0, credential: { kind: 'replace', key: 'SYNTHETIC-SECOND-KEY' } });
  assert.equal(b.ok, true);
  assert.equal((await f.post({ connectionID: second.id, expectedRevision: 2 })).statusCode, 200);
  const a2 = await f.models.run('save', { connection: savedDraft(), expectedRevision: a.expectedRevision, credential: { kind: 'replace', key: 'SYNTHETIC-ROTATED-KEY' } });
  assert.equal(a2.ok, true);
  assert.equal((await f.post(a)).json().error, 'configuration_conflict');
  assert.equal((await f.post({ ...a, expectedRevision: 3 })).statusCode, 200);
  assert.deepEqual(attempts, [[`${second.baseURL}/models`, 'Bearer SYNTHETIC-SECOND-KEY'], [`${savedDraft().baseURL}/models`, 'Bearer SYNTHETIC-ROTATED-KEY']]);
  assert.equal(f.reads(), 2);
});

test('provider errors, redirects and oversized lists disclose only fixed errors; shutdown revokes an active request', { ...use, timeout: 4000 }, async t => {
  let attempt = 0;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let signal: AbortSignal | null | undefined;
  const f = await fixture(t, async (_url, options) => {
    switch (++attempt) {
      case 1: return new Response(secret, { status: 401 });
      case 2: return new Response(secret, { status: 429 });
      case 3: return Response.redirect('https://elsewhere.invalid');
      case 4: return new Response('[]', { headers: { 'content-type': 'application/json', 'content-length': '1048577' } });
      default: signal = options?.signal; entered(); return new Promise(() => {});
    }
  });
  const input = await f.write();
  for (const error of ['authentication_failed', 'rate_limited', 'upstream_unavailable', 'response_too_large']) {
    const result = await f.post(input);
    assert.deepEqual(result.json(), { version: 1, ok: false, error });
  }
  const pending = f.models.discover(input); await started; await f.models.close();
  assert.equal(signal?.aborted, true);
  assert.deepEqual(await pending, { version: 1, ok: false, error: 'cancelled' });
  assert.deepEqual(await f.models.discover(input), { version: 1, ok: false, error: 'unavailable' });
});


test('oversized row count returns a bounded first batch with a truncation flag', use, async t => {
  let calls = 0;
  const data = Array.from({ length: 257 }, (_, i) => ({ id: `catalog-${i}` }));
  const f = await fixture(t, async () => { calls++; return Response.json({ data }); });
  const result = await f.post(await f.write());
  assert.equal(result.statusCode, 200);
  const body = result.json(); assert.equal(body.candidates.length, 256); assert.equal(body.truncated, true); assert.equal(calls, 1);
});

test('repeated cancellations cannot accumulate unfinished credential reads past the vault limit', { ...use, timeout: 4000 }, async t => {
  let entered!: () => void, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); t.after(release);
  const f = await fixture(t, async () => Response.json({ data: [] }), async () => { entered(); await held; });
  const input = await f.write();
  for (let i = 0; i < 3; i++) {
    const started = new Promise<void>(resolve => { entered = resolve; });
    const controller = new AbortController(), pending = f.models.discover(input, controller.signal);
    await started; controller.abort();
    assert.deepEqual(await pending, { version: 1, ok: false, error: 'cancelled' });
  }
  // On a broken implementation, do not leave the fourth read blocked until a timeout.
  entered = release;
  assert.deepEqual(await f.models.discover(input), { version: 1, ok: false, error: 'busy' });
  assert.equal(f.reads(), 3);
  release(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((await f.models.discover(input)).ok, true);
});
