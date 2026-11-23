import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { ModelClient } from '../src/models/client.ts';
import { resolveRoute } from '../src/models/config.ts';
import { ModelError } from '../src/models/errors.ts';
import { MODEL_PROTOCOLS, type ModelInput } from '../src/models/types.ts';
import { configuration } from './fixtures/models.ts';
import { textReply, toolReply } from './fixtures/model-replies.ts';
const input: ModelInput = { messages: [{ role: 'user', text: '合成问题' }] };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const code = (expected: string) => (error: unknown) => error instanceof ModelError && error.code === expected && error.message === expected && !('cause' in error);
for (const protocol of MODEL_PROTOCOLS) test(`${protocol}: transport uses only its auth/version, preserves prefix, and reads credentials only on explicit request`, async () => {
  let reads = 0, calls = 0;
  const config = configuration(protocol);
  const client = new ModelClient({ readConfiguration: () => config, readCredential: async ref => { reads++; assert.equal(ref, 'credential-version-one'); return 'SYNTHETIC-KEY'; }, fetch: async (url, init) => {
    calls++; const headers = new Headers(init?.headers);
    assert.equal(String(url), `https://synthetic.invalid/prefix/${protocol === 'gemini' ? 'v1beta/models/synthetic-model:generateContent' : `v1/${protocol === 'responses' ? 'responses' : protocol === 'anthropic' ? 'messages' : 'chat/completions'}`}`);
    assert.equal(init?.redirect, 'error'); assert.equal(init?.method, 'POST');
    assert.equal(headers.get('authorization'), protocol === 'chat-completions' || protocol === 'responses' ? 'Bearer SYNTHETIC-KEY' : null);
    assert.equal(headers.get('x-api-key'), protocol === 'anthropic' ? 'SYNTHETIC-KEY' : null);
    assert.equal(headers.get('x-goog-api-key'), protocol === 'gemini' ? 'SYNTHETIC-KEY' : null);
    assert.equal(headers.get('anthropic-version'), protocol === 'anthropic' ? '2023-06-01' : null);
    assert.doesNotMatch(String(url) + String(init?.body), /SYNTHETIC-KEY/);
    return response(textReply(protocol));
  } });
  assert.equal(reads, 0); assert.equal(calls, 0);
  assert.equal((await client.complete(undefined, 'text-chat', input)).message.text, '合成回复');
  assert.equal(reads, 1); assert.equal(calls, 1); client.close();
});
test('request snapshots route, budget, credential version and input before awaiting vault; next request uses fresh configuration', async () => {
  const config = configuration(), key = deferred<string | undefined>(), sent: Array<{ url: string; body: string; key: string | null }> = [];
  let reads = 0;
  const draft = structuredClone(input), selection = resolveRoute(config, undefined, 'speech');
  const client = new ModelClient({ readConfiguration: () => config, readCredential: async ref => { reads++; assert.equal(ref, reads === 1 ? 'credential-version-one' : 'credential-version-two'); return reads === 1 ? key.promise : 'SYNTHETIC-NEW'; }, fetch: async (url, init) => { sent.push({ url: String(url), body: String(init?.body), key: new Headers(init?.headers).get('authorization') }); return response(textReply('chat-completions')); } });
  const pending = client.complete(selection, 'speech', draft);
  config.connections[0]!.baseURL = 'https://changed.invalid/v1'; config.connections[0]!.credentialRef = 'credential-version-two'; config.connections[0]!.models[0]!.modelID = 'new-model'; draft.messages[0]!.text = '修改后';
  key.resolve('SYNTHETIC-OLD'); await pending;
  assert.equal(sent[0]!.url, 'https://synthetic.invalid/prefix/v1/chat/completions'); assert.match(sent[0]!.body, /合成问题/); assert.doesNotMatch(sent[0]!.body, /修改后|new-model/); assert.equal(JSON.parse(sent[0]!.body).max_completion_tokens, 160); assert.equal(sent[0]!.key, 'Bearer SYNTHETIC-OLD');
  await assert.rejects(client.complete(selection, 'speech', input), code('route_changed'));
  await client.complete(undefined, 'text-chat', input); assert.match(sent[1]!.url, /changed.invalid/); client.close();
});
test('invalid inputs, unknown tool support, stale routes and missing credentials fail before network without secret errors', async () => {
  let reads = 0, calls = 0;
  const config = configuration(), client = new ModelClient({ readConfiguration: () => config, readCredential: async () => { reads++; return undefined; }, fetch: async () => { calls++; throw Error('SECRET'); } });
  await assert.rejects(client.complete(undefined, 'text-chat', { messages: [{ role: 'user', text: 'a'.repeat(1201) }] }), code('invalid_request'));
  await assert.rejects(client.complete(undefined, 'text-chat', { ...input, tools: [{ name: 'tool', description: '', parameters: {} }] }), code('tools_unavailable'));
  await assert.rejects(client.complete(undefined, 'text-chat', { messages: [{ role: 'tool', toolCallID: 'missing', text: 'bad' }] }), code('invalid_request'));
  assert.equal(reads, 0);
  await assert.rejects(client.complete(undefined, 'text-chat', input), code('credentials_unavailable')); assert.equal(reads, 1); assert.equal(calls, 0); client.close();
});
test('max three active requests, cancellation/close settle even if vault ignores abort, and never send late results', async () => {
  let calls = 0; const key = deferred<string | undefined>(), controller = new AbortController();
  const client = new ModelClient({ readConfiguration: configuration, readCredential: () => key.promise, fetch: async () => { calls++; return response(textReply('chat-completions')); } });
  const a = client.complete(undefined, 'text-chat', input, controller.signal), b = client.complete(undefined, 'text-chat', input), c = client.complete(undefined, 'text-chat', input);
  await assert.rejects(client.complete(undefined, 'text-chat', input), code('busy'));
  controller.abort(); await assert.rejects(a, code('cancelled'));
  client.close(); await Promise.all([assert.rejects(b, code('closed')), assert.rejects(c, code('closed'))]);
  key.resolve('SYNTHETIC'); await new Promise(r => setImmediate(r)); assert.equal(calls, 0);
  await assert.rejects(client.complete(undefined, 'text-chat', input), code('closed'));
});
test('timeout covers pending credential read and releases active slots without a late fetch', async () => {
  let calls = 0; const key = deferred<string | undefined>();
  const client = new ModelClient({ readConfiguration: configuration, readCredential: () => key.promise, timeoutMs: 5, fetch: async () => { calls++; return response(textReply('chat-completions')); } });
  await assert.rejects(client.complete(undefined, 'text-chat', input), code('timed_out')); key.resolve('SYNTHETIC'); await new Promise(r => setImmediate(r)); assert.equal(calls, 0); client.close();
});
test('abort and timeout after fetch ignore late replies; pre-aborted input reads no credentials', async () => {
  let reads = 0; const upstream = deferred<Response>(), started = deferred<void>(), controller = new AbortController();
  const client = new ModelClient({ readConfiguration: configuration, readCredential: async () => { reads++; return 'SYNTHETIC'; }, fetch: async () => { started.resolve(); return upstream.promise; } });
  controller.abort(); await assert.rejects(client.complete(undefined, 'text-chat', input, controller.signal), code('cancelled')); assert.equal(reads, 0);
  const abort = new AbortController(), pending = client.complete(undefined, 'text-chat', input, abort.signal); await started.promise;
  abort.abort(); await assert.rejects(pending, code('cancelled')); upstream.resolve(response(textReply('chat-completions'))); await new Promise(r => setImmediate(r)); client.close();
});
test('non-2xx errors are redacted and never retried, including compatibility errors', async () => {
  for (const [status, expected] of [[401, 'authentication_failed'], [403, 'authentication_failed'], [429, 'rate_limited'], [400, 'upstream_unavailable'], [422, 'upstream_unavailable'], [500, 'upstream_unavailable'], [302, 'upstream_unavailable']] as const) {
    let calls = 0; const client = new ModelClient({ readConfiguration: configuration, readCredential: async () => 'SYNTHETIC', fetch: async () => { calls++; return response({ error: 'SECRET https://private.invalid' }, status); } });
    await assert.rejects(client.complete(undefined, 'text-chat', input), code(expected)); assert.equal(calls, 1); client.close();
  }
  for (const source of ['vault', 'fetch'] as const) {
    const client = new ModelClient({ readConfiguration: configuration, readCredential: async () => { if (source === 'vault') throw Error('SECRET'); return 'SYNTHETIC'; }, fetch: async () => { throw Error('SECRET'); } });
    await assert.rejects(client.complete(undefined, 'text-chat', input), code(source === 'vault' ? 'credentials_unavailable' : 'upstream_unavailable')); client.close();
  }
});
test('body is counted while streaming, rejects huge/chunked/malformed/non-json responses and cancels unread stream', async () => {
  for (const kind of ['length', 'chunked', 'malformed', 'type'] as const) {
    let cancelled = false;
    const client = new ModelClient({ readConfiguration: configuration, readCredential: async () => 'SYNTHETIC', fetch: async () => {
      if (kind === 'malformed') return new Response('{bad', { headers: { 'content-type': 'application/json' } });
      if (kind === 'type') return new Response('SECRET', { headers: { 'content-type': 'text/html' } });
      const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(600_000)); }, cancel() { cancelled = true; } });
      return new Response(stream, { headers: { 'content-type': 'application/json', ...(kind === 'length' ? { 'content-length': '1048577' } : {}) } });
    } });
    await assert.rejects(client.complete(undefined, 'text-chat', input), code(kind === 'length' || kind === 'chunked' ? 'response_too_large' : 'invalid_response'));
    if (kind === 'length' || kind === 'chunked') assert.equal(cancelled, true); client.close();
  }
});
test('abort while streaming cancels owned body instead of keeping a hidden reader alive', async () => {
  let cancelled = false; const started = deferred<void>(), abort = new AbortController();
  const client = new ModelClient({ readConfiguration: configuration, readCredential: async () => 'SYNTHETIC', fetch: async () => new Response(new ReadableStream({ pull() { started.resolve(); return new Promise<void>(() => {}); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } }) });
  const pending = client.complete(undefined, 'text-chat', input, abort.signal); await started.promise; abort.abort(); await assert.rejects(pending, code('cancelled')); await new Promise(r => setImmediate(r)); assert.equal(cancelled, true); client.close();
});
test('request byte budget is checked before credential read and unknown returned tools cannot be executed or accepted', async () => {
  let reads = 0; const config = configuration(); config.connections[0]!.models[0]!.capabilities.tools.status = 'supported';
  const client = new ModelClient({ readConfiguration: () => config, readCredential: async () => { reads++; return 'SYNTHETIC'; }, fetch: async () => response(toolReply('chat-completions')) });
  const oversized: ModelInput = { ...input, tools: Array.from({ length: 3 }, (_, i) => ({ name: `tool${i}`, description: '', parameters: { description: 'a'.repeat(60_000) } })) };
  await assert.rejects(client.complete(undefined, 'text-chat', oversized), code('invalid_request')); assert.equal(reads, 0);
  await assert.rejects(client.complete(undefined, 'text-chat', input), code('invalid_response')); client.close();
});
test('private replay metadata survives client snapshots only on original route', async () => {
  const config = configuration('anthropic'); config.connections[0]!.models[0]!.capabilities.tools.status = 'supported'; let calls = 0;
  const tool: ModelInput = { ...input, tools: [{ name: 'weather', description: '', parameters: { type: 'object' } }] };
  const client = new ModelClient({ readConfiguration: () => config, readCredential: async () => 'SYNTHETIC', fetch: async (_url, init) => {
    calls++; if (calls === 1) return response(toolReply('anthropic'));
    assert.match(String(init?.body), /private-signature/); return response(textReply('anthropic'));
  } });
  const first = await client.complete(undefined, 'text-chat', tool); assert.doesNotMatch(JSON.stringify(first), /private-signature/);
  await client.complete(undefined, 'text-chat', { ...tool, messages: [...input.messages, first.message, { role: 'tool', toolCallID: 'call-one', text: '合成结果' }] }); client.close();
});
test('discovery follows fixed protocol cursors, deduplicates IDs, stays read-only and reports page limit as truncated', async () => {
  const config = configuration('anthropic'), before = JSON.stringify(config); const paths: string[] = [];
  const client = new ModelClient({ readConfiguration: () => config, readCredential: async () => 'SYNTHETIC', fetch: async (url, init) => {
    assert.equal(init?.method, 'GET'); assert.equal(init?.body, undefined); paths.push(String(url)); return response({ data: [{ id: 'same', display_name: '合成' }], has_more: true, last_id: `cursor ${paths.length}` });
  } });
  const result = await client.discover('connection-one'); assert.equal(paths.length, 8); assert.match(paths[1]!, /after_id=cursor\+1/); assert.deepEqual(result, { models: [{ modelID: 'same', displayName: '合成', tools: 'unknown' }], truncated: true }); assert.equal(JSON.stringify(config), before); client.close();
});
test('discovery is bounded by 256 models, repeated cursors and 4MiB total, with no arbitrary next URL following', async () => {
  for (const kind of ['models', 'cursor', 'bytes'] as const) {
    const config = configuration('anthropic'); let calls = 0;
    const client = new ModelClient({ readConfiguration: () => config, readCredential: async () => 'SYNTHETIC', fetch: async (url) => {
      calls++; assert.match(String(url), /^https:\/\/synthetic.invalid\/prefix\/v1\/models\?/);
      return response({ data: Array.from({ length: kind === 'models' ? 100 : 1 }, (_, i) => ({ id: `model-${calls}-${i}` })), has_more: true, last_id: kind === 'cursor' ? 'repeat' : `page-${calls}`, ...(kind === 'bytes' ? { padding: 'a'.repeat(900_000) } : {}), next: 'https://attacker.invalid' });
    } });
    if (kind === 'bytes') await assert.rejects(client.discover('connection-one'), code('response_too_large'));
    else { const result = await client.discover('connection-one'); assert.equal(result.truncated, true); assert.equal(result.models.length, kind === 'models' ? 256 : 2); }
    assert.equal(calls, kind === 'models' ? 3 : kind === 'cursor' ? 2 : 5); client.close();
  }
});
for (const mode of ['apiKey', 'none'] as const) test(`loopback without a Key (${mode}) uses real local server, preserves prefix and refuses redirect`, async () => {
  let hits = 0, auth: string | undefined; const paths: string[] = [];
  const server = createServer((req, res) => { hits++; paths.push(req.url!); auth = req.headers.authorization; if (req.url?.endsWith('/models')) { res.writeHead(302, { location: '/forbidden' }); res.end(); } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(textReply('chat-completions'))); } });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const config = configuration(); config.connections[0]!.baseURL = `http://127.0.0.1:${address.port}/deployment/v1`; config.connections[0]!.authMode = mode; delete config.connections[0]!.credentialRef;
  const client = new ModelClient({ readConfiguration: () => config, readCredential: async () => { throw Error('must not read'); } });
  try { await client.complete(undefined, 'text-chat', input); assert.equal(auth, undefined); await assert.rejects(client.discover('connection-one'), code('upstream_unavailable')); assert.equal(hits, 2); assert.deepEqual(paths, ['/deployment/v1/chat/completions', '/deployment/v1/models']); }
  finally { client.close(); server.closeAllConnections(); await new Promise<void>((r, reject) => server.close(e => e ? reject(e) : r())); }
});
