import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelIPC, MODEL_IPC } from '../src/model-ipc.ts';
import type { ModelDiscoveryInput, ModelDiscoveryReply, ModelDraft, ModelManagementReply } from '../../../packages/contracts/src/models.ts';

const draft: ModelDraft = { id: 'a', displayName: '连接 A', preset: 'custom', apiProtocol: 'responses', baseURL: 'https://example.invalid/v1', authMode: 'apiKey', defaultModelEntryID: 'm', compatibility: {}, models: [{ entryID: 'm', modelID: 'sample', displayName: '样例', compatibility: {}, capabilities: { tools: { status: 'unknown', source: 'user' } } }] };
const ok: Extract<ModelManagementReply, { ok: true }> = { version: 1, ok: true, configuration: { revision: 0, defaultConnectionID: null, connections: [] } };
function fixture(save?: () => Promise<ModelManagementReply>, list = async (): Promise<ModelManagementReply> => ok) {
  const writes: unknown[] = [];
  const ipc = new ModelIPC({ listModels: list, saveModelConnection: async value => { writes.push(value); return save ? save() : ok; }, setModelDefault: async () => ok, removeModelConnection: async () => ok });
  const request = (method: keyof typeof MODEL_IPC, ...args: unknown[]) => ipc.invoke(method, true, args);
  return { ipc, request, writes };
}

test('the existing save channel accepts a bounded new Key only from a trusted caller', async () => {
  const f = fixture();
  const input = { connection: draft, expectedRevision: 5, credential: { kind: 'replace', key: 'synthetic-entered-key' } };
  assert.equal((await f.ipc.invoke('save', false, [input])).ok, false);
  assert.equal((await f.request('save', input, 'extra')).ok, false);
  for (const key of ['', 'has spaces', 'new\nline', 'ending\n', 'x'.repeat(8193)])
    assert.equal((await f.request('save', { ...input, credential: { kind: 'replace', key } })).ok, false);
  assert.equal((await f.request('save', { ...input, connection: { ...draft, authMode: 'none' } })).ok, false);
  assert.equal((await f.request('save', { ...input, connection: { ...draft, credentialRef: 'ref' } })).ok, false);
  assert.equal((await f.request('save', { ...input, credential: { ...input.credential, extra: true } })).ok, false);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(await f.request('save', input), ok);
  assert.deepEqual(f.writes, [input]);
});

test('credential writes are serialized and an uncertain publication prevents further writes', async () => {
  let finish!: (reply: ModelManagementReply) => void;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const input = { connection: draft, expectedRevision: 5, credential: { kind: 'replace', key: 'synthetic-entered-key' } };
  const pending = f.request('save', input);
  assert.deepEqual(await f.request('save', input), { version: 1, ok: false, error: 'busy' });
  assert.deepEqual(await f.request('list'), ok);
  const uncertain = { version: 1, ok: false, error: 'publication_uncertain' } as const;
  finish(uncertain);
  assert.deepEqual(await pending, uncertain);
  assert.deepEqual(await f.request('save', input), uncertain);
  assert.deepEqual(f.writes, [input]);
});

test('a read-only service can still be listed but rejects credential replacement', async () => {
  const blocked = { ...ok, writesBlocked: true as const };
  const f = fixture(undefined, async () => blocked);
  assert.equal((await f.ipc.invoke('list', false, [])).ok, false);
  assert.equal((await f.request('list', null)).ok, false);
  assert.deepEqual(await f.request('list'), blocked);
  assert.deepEqual(await f.request('save', { connection: draft, expectedRevision: 0, credential: { kind: 'replace', key: 'synthetic' } }),
    { version: 1, ok: false, error: 'publication_uncertain' });
  assert.equal(f.writes.length, 0);
});

test('discovery forwards only a saved selection and cancels by operation ID or workspace lifecycle', async () => {
  const requests: { input: ModelDiscoveryInput; signal: AbortSignal }[] = [];
  let finish!: (value: ModelDiscoveryReply) => void;
  const ipc = new ModelIPC({ listModels: async () => ok, saveModelConnection: async () => ok, setModelDefault: async () => ok, removeModelConnection: async () => ok,
    discoverModels: (input, signal) => { requests.push({ input, signal }); return new Promise(resolve => { finish = resolve; }); },
  });
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
  });
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
