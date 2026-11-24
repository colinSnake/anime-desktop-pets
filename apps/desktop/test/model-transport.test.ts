import assert from 'node:assert/strict';
import test from 'node:test';
import { requestModelDiscovery, requestModelManagement, requestModelProbe } from '../src/model-transport.ts';
import { configuration } from '../../app-service/test/fixtures/models.ts';
import { MODEL_RESPONSE_LIMIT } from '../../app-service/src/models/management-contract.ts';

const connection = { port: 32000, token: 'b'.repeat(64) };
const ok = { version:1, ok:true, configuration:{ revision:0, defaultConnectionID:null, connections:[] } };
const defaultInput = {expectedRevision:0, connectionID:null};
const unknown = { version:1, ok:false, error:'write_outcome_unknown' };
const unavailable = { version:1, ok:false, error:'unavailable' };
test('trusted transport uses a fixed loopback route, GET without body, no redirects and a private bearer', async () => {
  const result = await requestModelManagement(connection, 'list', undefined, async (url, options) => {
    assert.equal(url,'http://127.0.0.1:32000/v1/models'); assert.equal(options?.method,'GET');
    assert.equal(options?.redirect,'error'); assert.equal(options?.body,undefined);
    assert.equal(new Headers(options?.headers).get('authorization'),`Bearer ${connection.token}`);
    return Response.json(ok);
  });
  assert.deepEqual(result,ok);
});
test('invalid and credential-rebinding inputs never reach the network', async () => {
  const fetch: typeof globalThis.fetch = async () => assert.fail('unexpected fetch');
  const { revision: _r, ...draft } = configuration().connections[0]!;
  const input = {connection:draft,expectedRevision:0,credential:{kind:'keep' as const}};
  assert.deepEqual(await requestModelManagement(connection,'save',input,fetch),{version:1,ok:false,error:'invalid_configuration'});
  assert.deepEqual(await requestModelManagement(connection,'default',{...defaultInput,headers:{foo:'SYNTHETIC'}} as typeof defaultInput,fetch),{version:1,ok:false,error:'invalid_configuration'});
});
test('mutation returns explicit durability and conflict rather than retrying', async () => {
  let calls = 0;
  const conflict = { version:1,ok:false,error:'configuration_conflict' };
  const committed = { ...ok, durability:'unconfirmed', retainedCredentialVersions:true };
  const fetch: typeof globalThis.fetch = async (url, options) => {
    assert.equal(url,'http://127.0.0.1:32000/v1/models/default'); assert.equal(options?.method,'POST'); assert.deepEqual(JSON.parse(String(options?.body)),defaultInput);
    return ++calls === 1 ? Response.json(conflict,{status:409}) : Response.json(committed);
  };
  assert.deepEqual(await requestModelManagement(connection,'default',defaultInput,fetch),conflict); assert.equal(calls,1);
  assert.deepEqual(await requestModelManagement(connection,'default',defaultInput,fetch),committed); assert.equal(calls,2);
});
test('broken transport or malformed and unsafe replies cannot report a write rollback or leak private fields', async () => {
  const options: Array<typeof fetch> = [
    async () => { throw Error('SYNTHETIC-SECRET'); },
    async () => Response.json({...ok, durability:'confirmed', retainedCredentialVersions:false, secret:'SYNTHETIC'}),
    async () => Response.json({...ok, configuration: { ...configuration(), connections: [{...configuration().connections[0],credentialState:'reference-present'}] }}),
    async () => Response.json({...ok, durability:'confirmed', retainedCredentialVersions:false},{status:503}),
  ];
  for (const fetch of options) assert.deepEqual(await requestModelManagement(connection,'default',defaultInput,fetch),unknown);
  assert.deepEqual(await requestModelManagement(connection,'list',undefined,options[2]!),unavailable);
  const credentialRef = configuration().connections[0]!;
  const privateValue = { ...ok, configuration:{revision:1,defaultConnectionID:null,connections:[{...credentialRef,credentialState:'reference-present'}]} };
  assert.deepEqual(await requestModelManagement(connection,'list',undefined,async () => Response.json(privateValue)),unavailable);
});
test('oversize streamed replies are cancelled without parsing', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new Uint8Array(MODEL_RESPONSE_LIMIT)); c.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; },
  });
  assert.deepEqual(await requestModelManagement(connection,'list',undefined,async () => new Response(body,{headers:{'content-type':'application/json'}})),unavailable);
  assert.equal(cancelled,true);
});

test('write block status belongs only to a validated list response', async () => {
  const readOnly = { ...ok, writesBlocked: true };
  assert.deepEqual(await requestModelManagement(connection, 'list', undefined, async () => Response.json(readOnly)), readOnly);
  assert.deepEqual(await requestModelManagement(connection, 'list', undefined, async () => Response.json({ ...readOnly, writesBlocked: 'yes' })), unavailable);
  assert.deepEqual(await requestModelManagement(connection, 'default', defaultInput, async () => Response.json({ ...readOnly, durability: 'confirmed', retainedCredentialVersions: false })), unknown);
});

test('discovery uses only the saved ID and revision, rejecting mismatched, private or malformed replies', async () => {
  const input = { connectionID: 'saved-a', expectedRevision: 4 }, controller = new AbortController();
  const candidate = { modelID: 'sample-v1', displayName: 'Sample' };
  const success = { version: 1, ok: true, connectionID: 'saved-a', revision: 4, truncated: false, candidates: [candidate] };
  assert.deepEqual(await requestModelDiscovery(connection, input, controller.signal, async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:32000/v1/models/discover'); assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${connection.token}`); assert.deepEqual(JSON.parse(String(init?.body)), input);
    return Response.json(success);
  }), success);
  for (const reply of [{ ...success, revision: 3 }, { ...success, connectionID: 'other' }, { ...success, cursor: 'private' },
    { ...success, candidates: [{ ...candidate, credentialRef: 'private' }] }, { ...success, candidates: [candidate, candidate] }]) {
    assert.deepEqual(await requestModelDiscovery(connection, input, controller.signal, async () => Response.json(reply)), unavailable);
  }
  assert.deepEqual(await requestModelDiscovery(connection, { ...input, key: 'private' } as typeof input, controller.signal, async () => assert.fail()), { version: 1, ok: false, error: 'invalid_configuration' });
  assert.deepEqual(await requestModelDiscovery(connection, input, controller.signal, async () => { throw Error('private'); }), unavailable);
  controller.abort();
  assert.deepEqual(await requestModelDiscovery(connection, input, controller.signal, async () => assert.fail()), { version: 1, ok: false, error: 'cancelled' });
});

test('probe transport only accepts results for the requested connection version and model entry', async () => {
  const input = { connectionID: 'saved-a', expectedRevision: 4, entryID: 'entry-a', modelID: 'draft-model' };
  const signal = new AbortController().signal;
  const success = { version: 1, ok: true, connectionID: input.connectionID, revision: input.expectedRevision, entryID: input.entryID };
  assert.deepEqual(await requestModelProbe(connection, input, signal, async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:32000/v1/models/test');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${connection.token}`);
    assert.deepEqual(JSON.parse(String(init?.body)), input);
    return Response.json(success);
  }), success);
  for (const forged of [{ ...success, entryID: 'wrong' }, { ...success, revision: 3 }, { ...success, providerBody: 'private' }]) {
    assert.deepEqual(await requestModelProbe(connection, input, signal, async () => Response.json(forged)), unavailable);
  }
  assert.deepEqual(await requestModelProbe(connection, input, signal, async () => Response.json(success, { status: 503 })), unavailable);
});


test('trusted probe transport allows the service streaming deadline plus bridge margin and accepts fixed diagnostics', async t => {
  const input = { connectionID: 'saved-a', expectedRevision: 4, entryID: 'entry-a', modelID: 'draft-model' };
  const signal = new AbortController().signal;
  const deadline = t.mock.method(AbortSignal, 'timeout', () => signal);
  const diagnostic = { version: 1, ok: false, error: 'output_budget_exhausted' };
  assert.deepEqual(await requestModelProbe(connection, input, signal, async () => Response.json(diagnostic, { status: 502 })), diagnostic);
  assert.deepEqual(deadline.mock.calls.map(call => call.arguments), [[62_000]]);
});

test('the loopback model bridge accepts a probe storage warning only on a list without evidence', async () => {
  const warning = { ...ok, probeStorageUnavailable: true };
  assert.deepEqual(await requestModelManagement(connection, 'list', undefined, async () => Response.json(warning)), warning);
  for (const malformed of [{ ...warning, probeStorageUnavailable: 'private detail' }, { ...warning, probeResults: [] }]) {
    assert.deepEqual(await requestModelManagement(connection, 'list', undefined, async () => Response.json(malformed)), unavailable);
  }
  assert.deepEqual(await requestModelManagement(connection, 'default', defaultInput, async () => Response.json({ ...warning, durability: 'confirmed', retainedCredentialVersions: false })), unknown);
});
