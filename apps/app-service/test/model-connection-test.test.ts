import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ModelClient } from '../src/models/client.ts';
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
const completedResponse = (text = 'OK') => ({ status: 'completed', output: [
  { type: 'reasoning', id: 'reasoning', encrypted_content: 'private', summary: [] },
  { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] },
] });
const eventBytes = (...events: unknown[]) => Buffer.from(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
const responsesStream = (chunks: Uint8Array[], onCancel?: () => void) => new Response(new ReadableStream<Uint8Array>({
  start(controller) { for (const chunk of chunks) controller.enqueue(chunk); if (!onCancel) controller.close(); },
  cancel() { onCancel?.(); },
}), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
async function fixture(t: TestContext, fetch: typeof globalThis.fetch, beforeRead?: () => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'model-probe-')));
  const { backend } = syntheticVault(); let reads = 0;
  const models = new ModelManagement(root, { ...backend, read: async (...args) => { reads++; await beforeRead?.(); return backend.read(...args); } }, undefined, { fetch });
  const snapshot = () => ({ kind: 'diagnostic' as const, status: 'idle' as const, detail: '' });
  const app = createService({ token: 'a'.repeat(64), models, runtime: { snapshot, probe: async () => snapshot(), close: async () => {} } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const save = async (id: string, protocol: ModelProtocol, expectedRevision = 0, hasKey = true, baseURL?: string) => {
    const { revision, credentialRef, ...draft } = configuration(protocol).connections[0]!;
    const saved = await models.run('save', { connection: { ...draft, id, baseURL: baseURL ?? `https://${id}.invalid/prefix/${protocol === 'gemini' ? 'v1beta' : 'v1'}` }, expectedRevision, credential: hasKey ? { kind: 'replace', key: `SYNTHETIC-KEY-${id}` } : { kind: 'keep' } }); if (!saved.ok) throw new Error(`save fixture failed: ${saved.error}`);
  };
  const post = (payload: object, auth = headers) => app.inject({ method: 'POST', url: '/v1/models/test', headers: auth, payload });
  await save('other', 'chat-completions');
  return { app, post, save, models, reads: () => reads };
}
for (const protocol of MODEL_PROTOCOLS) test(`${protocol}: tests only the chosen saved destination and current draft model, without saving or relaying provider content`, local, async t => {
  let call: { url: string; headers: Headers; body: { model?: string; stream?: boolean; input?: unknown; max_tokens?: number; max_output_tokens?: number; generationConfig?: { maxOutputTokens: number }; tools?: unknown } } | undefined;
  const f = await fixture(t, async (url, init) => {
    assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error'); assert.equal(call, undefined);
    call = { url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
    return Response.json(protocol === 'responses' ? completedResponse() : textReply(protocol));
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
  assert.match(JSON.stringify(call!.body), protocol === 'responses' ? /Reply with exactly OK\./ : /Reply with OK\./); assert.equal(call!.body.tools, undefined); assert.equal(f.reads(), 1);
});


test('Responses finishes at a complete split SSE event without waiting for the gateway to close', { ...local, timeout: 3_000 }, async t => {
  let cancelled = false, calls = 0, body: { stream?: boolean; input?: unknown; max_output_tokens?: number } | undefined;
  const bytes = eventBytes({ type: 'response.output_text.delta', delta: '增量' }, { type: 'response.completed', response: completedResponse() });
  const splitUtf8 = bytes.indexOf('增') + 1, splitCrLf = bytes.indexOf('\r\n') + 1;
  const f = await fixture(t, async (_url, init) => {
    calls++;
    body = JSON.parse(String(init?.body));
    assert.match(new Headers(init?.headers).get('accept') ?? '', /text\/event-stream/);
    return responsesStream([bytes.subarray(0, splitUtf8), bytes.subarray(splitUtf8, splitCrLf), new Uint8Array(), bytes.subarray(splitCrLf)], () => { cancelled = true; });
  });
  await f.save('probe', 'responses');
  const result = await f.post({ ...input, maxOutputTokens: 1024 });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(body?.stream, true);
  assert.ok(Array.isArray(body?.input));
  assert.equal(body?.max_output_tokens, 256);
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
});

test('DeepSeek official Responses keeps the established non-streaming JSON probe', local, async t => {
  let body: { stream?: boolean; max_output_tokens?: number } | undefined;
  const f = await fixture(t, async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json(textReply('responses'));
  });
  await f.save('official', 'responses', 0, true, 'https://api.deepseek.com/v1');
  const result = await f.post({ ...input, connectionID: 'official', maxOutputTokens: 1024 });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(body?.stream, false);
  assert.equal(body?.max_output_tokens, 32);
});

test('Responses rejects malformed, failed, truncated and non-marker replies', local, async t => {
  let response: Response;
  const f = await fixture(t, async () => response);
  await f.save('probe', 'responses');
  const completed = { type: 'response.completed', response: completedResponse() };
  for (const candidate of [
    responsesStream([eventBytes({ type: 'response.output_text.delta', delta: 'OK' })]),
    responsesStream([eventBytes(completed).subarray(0, -2)]),
    responsesStream([Buffer.from('event: response.failed\ndata: ' + JSON.stringify(completed) + '\n\n')]),
    responsesStream([eventBytes({ type: 'response.failed', response: completedResponse() })]),
    responsesStream([eventBytes({ ...completed, response: { ...completed.response, status: 'in_progress' } })]),
    responsesStream([eventBytes({ ...completed, response: { ...completed.response, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } })]),
    responsesStream([Buffer.from([0xff])]),
    Response.json(completedResponse('not OK')),
  ]) {
    response = candidate;
    assert.deepEqual((await f.post(input)).json(), { version: 1, ok: false, error: 'invalid_response' });
  }
});

test('Responses distinguishes an exhausted output budget from a completed check in SSE and JSON', local, async t => {
  const incomplete = { ...completedResponse(), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
  let calls = 0;
  const f = await fixture(t, async () => ++calls === 1
    ? responsesStream([eventBytes({ type: 'response.incomplete', response: incomplete })])
    : Response.json(incomplete));
  await f.save('probe', 'responses');
  for (let i = 0; i < 2; i++) assert.deepEqual((await f.post(input)).json(), { version: 1, ok: false, error: 'output_budget_exhausted' });
  assert.equal(calls, 2);
});

test('probe response bytes stay bounded even if an oversize stream ends in a success event', local, async t => {
  let cancelled = false;
  const oversized = Buffer.concat([Buffer.alloc(64 * 1024, 0x20), eventBytes({ type: 'response.completed', response: completedResponse() })]);
  const f = await fixture(t, async () => responsesStream([oversized], () => { cancelled = true; }));
  await f.save('probe', 'responses');
  assert.deepEqual((await f.post(input)).json(), { version: 1, ok: false, error: 'response_too_large' });
  assert.equal(cancelled, true);
});

test('HTTP probe failures use fixed diagnostics and do not relay provider errors or retry', local, async t => {
  let calls = 0, status = 0;
  const f = await fixture(t, async () => { calls++; return Response.json({ error: 'PRIVATE-FIXTURE' }, { status }); });
  await f.save('probe', 'chat-completions');
  const failures = [[400, 'provider_bad_request'], [422, 'provider_bad_request'], [401, 'authentication_failed'],
    [403, 'provider_forbidden'], [404, 'provider_not_found'], [429, 'rate_limited'], [500, 'upstream_unavailable']] as const;
  for (const [code, error] of failures) {
    status = code;
    assert.deepEqual((await f.post(input)).json(), { version: 1, ok: false, error });
  }
  assert.equal(calls, failures.length);
});

test('only streaming Responses can wait up to 60s; the deadline cancels the provider body', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [protocol, timeout] of [['responses', 60_000], ['chat-completions', 15_000]] as const) {
    let cancelled = false;
    const reading = deferred();
    const client = new ModelClient({ readConfiguration: () => configuration(protocol), readCredential: async () => 'SYNTHETIC-KEY', fetch: async () => new Response(new ReadableStream({
      pull() { reading.resolve(); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { headers: { 'content-type': protocol === 'responses' ? 'text/event-stream' : 'application/json' } }) });
    const pending = client.testConnection({ ...input, connectionID: 'connection-one', expectedRevision: 1 }, new AbortController().signal);
    const result = assert.rejects(pending, { code: 'timed_out' });
    await reading.promise;
    t.mock.timers.tick(timeout - 1);
    assert.equal(cancelled, false);
    t.mock.timers.tick(1);
    await result;
    assert.equal(cancelled, true);
  }
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
