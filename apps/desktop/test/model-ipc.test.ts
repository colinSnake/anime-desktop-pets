import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelIPC, MODEL_IPC, type ModelMenuIntent } from '../src/model-ipc.ts';
import type { ModelDiscoveryInput, ModelDiscoveryReply, ModelDraft, ModelManagementReply } from '../../../packages/contracts/src/models.ts';

const draft: ModelDraft = { id: 'a', displayName: '连接 A', preset: 'custom', apiProtocol: 'responses', baseURL: 'https://example.invalid/v1', authMode: 'apiKey', defaultModelEntryID: 'm', compatibility: {}, models: [{ entryID: 'm', modelID: 'sample', displayName: '样例', compatibility: {}, capabilities: { tools: { status: 'unknown', source: 'user' } } }] };
const ok: Extract<ModelManagementReply, { ok: true }> = { version: 1, ok: true, configuration: { revision: 0, defaultConnectionID: null, connections: [] } };
function fixture(read: () => string | Promise<string> = () => 'synthetic-clipboard-key') {
  let reads = 0;
  const writes: unknown[] = [], menu: (ModelMenuIntent | undefined)[] = [];
  const ipc = new ModelIPC({ listModels: async () => ok, saveModelConnection: async value => { writes.push(value); return ok; }, setModelDefault: async () => ok, removeModelConnection: async () => ok }, {
    readClipboard: () => { reads++; return read(); }, menuChanged: origin => menu.push(origin), expiresMs: 100,
  });
  const request = (method: keyof typeof MODEL_IPC, ...args: unknown[]) => ipc.invoke(method, true, args);
  return { ipc, request, reads: () => reads, writes, menu };
}

test('model IPC rejects untrusted frames, extra arguments, private fields and any supplied key', async () => {
  const f = fixture();
  assert.equal((await f.ipc.invoke('list', false, [])).ok, false);
  assert.equal((await f.request('list', null)).ok, false);
  assert.equal((await f.request('save', { connection: draft, expectedRevision: 0, credential: { kind: 'replace', key: 'renderer-key' } })).ok, false);
  assert.equal((await f.request('prepareKeySave', { connection: { ...draft, credentialRef: 'ref' }, expectedRevision: 0 })).ok, false);
  assert.equal((await f.request('prepareKeySave', { connection: draft, expectedRevision: 0, key: 'renderer-key' })).ok, false);
  assert.equal((await f.request('save', { connection: draft, expectedRevision: 0, credential: { kind: 'keep' } })).ok, true);
  assert.equal(f.reads(), 0); assert.equal(f.writes.length, 1);
});

test('only a focused native menu click reads once, binds to the original draft and sends directly to the service', async () => {
  const f = fixture();
  f.menu.at(-1)?.submit(true); assert.equal(f.reads(), 0);
  const input = { connection: structuredClone(draft), expectedRevision: 5 };
  const pending = f.request('prepareKeySave', input);
  input.connection.baseURL = 'https://other.invalid';
  assert.equal(f.menu[0]?.origin, 'https://example.invalid');
  assert.equal((await f.request('save', { ...input, credential: { kind: 'keep' } })).ok, false);
  f.menu.at(-1)?.submit(false); assert.equal(f.reads(), 0);
  f.menu.at(-1)?.submit(true); f.menu.at(-1)?.submit(true);
  assert.deepEqual(await pending, ok); assert.equal(f.reads(), 1);
  assert.deepEqual(f.writes, [{ connection: draft, expectedRevision: 5, credential: { kind: 'replace', key: 'synthetic-clipboard-key' } }]);
  assert.equal(f.menu.at(-1), undefined);
});

test('cancel, expiry, lifecycle shutdown and bad clipboard never send a credential write', async () => {
  const f = fixture(() => '  multiple lines\n');
  const input = { connection: draft, expectedRevision: 0 };
  const cancelled = f.request('prepareKeySave', input);
  await f.request('cancelKeySave'); assert.deepEqual(await cancelled, { version: 1, ok: false, error: 'key_input_cancelled' });
  f.menu.at(-1)?.submit(true); assert.equal(f.reads(), 0);
  assert.deepEqual(await f.request('prepareKeySave', input), { version: 1, ok: false, error: 'key_input_expired' });
  f.menu.at(-1)?.submit(true); assert.equal(f.reads(), 0);
  const bad = f.request('prepareKeySave', input); f.menu.at(-1)?.submit(true);
  assert.deepEqual(await bad, { version: 1, ok: false, error: 'clipboard_not_key' });
  const gone = f.request('prepareKeySave', input); f.ipc.cancel();
  assert.deepEqual(await gone, { version: 1, ok: false, error: 'key_input_cancelled' });
  assert.equal(f.writes.length, 0);
});

test('a stale native menu item cannot submit a newly prepared destination', async () => {
  const f = fixture();
  const first = f.request('prepareKeySave', { connection: draft, expectedRevision: 0 });
  const oldItem = f.menu.at(-1)!;
  await f.request('cancelKeySave'); await first;
  const next = f.request('prepareKeySave', { connection: { ...draft, baseURL: 'https://other.invalid' }, expectedRevision: 0 });
  oldItem.submit(true); assert.equal(f.reads(), 0);
  f.menu.at(-1)!.submit(true); assert.equal((await next).ok, true); assert.equal(f.reads(), 1);
});

test('navigation or cancel during the asynchronous clipboard read prevents sending any credential', async () => {
  let release!: (value: string) => void;
  const clipboard = new Promise<string>(resolve => { release = resolve; });
  const f = fixture(() => clipboard);
  const pending = f.request('prepareKeySave', { connection: draft, expectedRevision: 0 });
  f.menu.at(-1)!.submit(true); assert.equal(f.reads(), 1);
  f.ipc.cancel(); release('synthetic-clipboard-key');
  assert.deepEqual(await pending, { version: 1, ok: false, error: 'key_input_cancelled' });
  assert.equal(f.writes.length, 0);
});

test('a read-only service can still be listed but cannot arm native clipboard input', async () => {
  let reads = 0;
  const blocked = { ...ok, writesBlocked: true as const };
  const unexpected = async () => { throw new Error('unexpected write'); };
  const ipc = new ModelIPC({ listModels: async () => blocked, saveModelConnection: unexpected, setModelDefault: unexpected, removeModelConnection: unexpected }, {
    readClipboard: () => { reads++; return 'synthetic-clipboard-key'; }, menuChanged: () => assert.fail('must not arm menu'), expiresMs: 25,
  });
  assert.deepEqual(await ipc.invoke('list', true, []), blocked);
  assert.deepEqual(await ipc.invoke('prepareKeySave', true, [{ connection: draft, expectedRevision: 0 }]), { version: 1, ok: false, error: 'publication_uncertain' });
  assert.equal(reads, 0);
});

test('discovery forwards only a saved selection and cancels by operation ID or workspace lifecycle', async () => {
  const requests: { input: ModelDiscoveryInput; signal: AbortSignal }[] = [];
  let finish!: (value: ModelDiscoveryReply) => void;
  const ipc = new ModelIPC({ listModels: async () => ok, saveModelConnection: async () => ok, setModelDefault: async () => ok, removeModelConnection: async () => ok,
    discoverModels: (input, signal) => { requests.push({ input, signal }); return new Promise(resolve => { finish = resolve; }); },
  }, { readClipboard: () => assert.fail('discovery must not read clipboard'), menuChanged: () => {} });
  const input = { connectionID: 'saved-a', expectedRevision: 4, operationID: 'op-1' };
  for (const args of [[], [input, 2], [{ ...input, key: 'synthetic' }], [{ ...input, baseURL: 'https://other.invalid' }], [{ ...input, operationID: 'x'.repeat(65) }]]) {
    assert.equal((await ipc.invokeDiscovery('discover', true, args)).ok, false);
  }
  assert.equal((await ipc.invokeDiscovery('discover', false, [input])).ok, false);
  assert.equal(requests.length, 0);
  const pending = ipc.invokeDiscovery('discover', true, [input]);
  const first = requests[0]!;
  assert.deepEqual(first.input, { connectionID: 'saved-a', expectedRevision: 4 });
  assert.equal((await ipc.invokeDiscovery('discover', true, [{ ...input, operationID: 'op-2' }])).ok, false);
  await ipc.invokeDiscovery('cancelDiscovery', false, ['op-1']);
  await ipc.invokeDiscovery('cancelDiscovery', true, ['op-2']);
  await ipc.invoke('cancelKeySave', true, []);
  assert.equal(first.signal.aborted, false);
  await ipc.invokeDiscovery('cancelDiscovery', true, ['op-1']);
  const cancelled = { version: 1, ok: false, error: 'cancelled' };
  assert.deepEqual(await pending, cancelled); assert.equal(first.signal.aborted, true);
  finish({ version: 1, ok: true, connectionID: 'saved-a', revision: 4, candidates: [], truncated: false });
  const next = ipc.invokeDiscovery('discover', true, [{ ...input, operationID: 'op-2' }]);
  ipc.cancel();
  assert.deepEqual(await next, cancelled); assert.equal(requests[1]?.signal.aborted, true);
});

test('connection test IPC validates the trusted caller, forwards only pinned model fields, and discards cancelled replies', async () => {
  let finish!: (value: import('../../../packages/contracts/src/model-probe.ts').ModelProbeReply) => void;
  let received: unknown, receivedSignal: AbortSignal | undefined;
  const ipc = new ModelIPC({ listModels: async () => ok, saveModelConnection: async () => ok, setModelDefault: async () => ok, removeModelConnection: async () => ok,
    testModelConnection: (value, signal) => { received = value; receivedSignal = signal; return new Promise(resolve => { finish = resolve; }); },
  }, { readClipboard: () => assert.fail('clipboard must not be read'), menuChanged: () => {} });
  const payload = { operationID: 'job-a', connectionID: 'a', expectedRevision: 2, entryID: 'm', modelID: 'model' };
  assert.equal((await ipc.invokeProbe('testConnection', false, [payload])).ok, false);
  assert.equal((await ipc.invokeProbe('testConnection', true, [{ ...payload, url: 'https://other.invalid' }])).ok, false);
  assert.equal(received, undefined);
  const running = ipc.invokeProbe('testConnection', true, [payload]);
  assert.deepEqual(received, { connectionID: 'a', expectedRevision: 2, entryID: 'm', modelID: 'model' });
  await ipc.invokeProbe('cancelConnectionTest', true, ['job-other']); assert.equal(receivedSignal?.aborted, false);
  await ipc.invokeProbe('cancelConnectionTest', true, [payload.operationID]); assert.equal(receivedSignal?.aborted, true);
  assert.deepEqual(await running, { version: 1, ok: false, error: 'cancelled' });
  finish({ version: 1, ok: true, connectionID: 'a', revision: 2, entryID: 'm' });
});
