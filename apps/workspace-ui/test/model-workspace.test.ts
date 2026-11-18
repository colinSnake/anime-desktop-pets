import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ModelDiscoveryReply, ModelsBridge, ModelWorkspaceReply, SavedModelConfiguration, SavedModelConnection } from '../../../packages/contracts/src/models.ts';
import { ModelWorkspaceController } from '../src/model-state.ts';
import { ModelPage } from '../src/ModelPage.tsx';

const entry = (id: string) => ({ entryID: id, modelID: id, displayName: id, compatibility: {}, capabilities: { tools: { status: 'unknown' as const, source: 'user' as const } } });
const connection = (id: string, revision: number): SavedModelConnection => ({ id, displayName: `连接 ${id}`, revision, preset: 'custom', apiProtocol: 'chat-completions', baseURL: 'https://example.invalid/v1', authMode: 'apiKey', credentialState: 'missing', defaultModelEntryID: 'm', compatibility: {}, models: [entry('m'), entry('n')] });
const initial = (): SavedModelConfiguration => ({ revision: 3, defaultConnectionID: 'a', connections: [connection('a', 1), connection('b', 2)] });
const good = (configuration = initial()): ModelWorkspaceReply => ({ version: 1, ok: true, configuration });
const bad = (error: Extract<ModelWorkspaceReply, { ok: false }>['error']): ModelWorkspaceReply => ({ version: 1, ok: false, error });
function fixture(overrides: Partial<ModelsBridge> = {}) {
  const inputs: [string, unknown][] = [];
  const bridge: ModelsBridge = {
    list: async () => good(), save: async input => { inputs.push(['save', input]); return good({ ...initial(), revision: 4, connections: [...initial().connections.filter(c => c.id !== input.connection.id), { ...input.connection, credentialState: 'missing', revision: 4 }] }); },
    setDefault: async input => { inputs.push(['default', input]); return good(); }, remove: async input => { inputs.push(['remove', input]); return good(); },
    prepareKeySave: async input => { inputs.push(['key', input]); return bad('key_input_cancelled'); }, cancelKeySave: async () => { inputs.push(['cancel', undefined]); }, ...overrides,
  };
  const controller = new ModelWorkspaceController(bridge, () => `generated-${inputs.length}-${++next}`);
  let next = 0;
  return { controller, inputs, get: controller.getSnapshot };
}

test('independent connection and model folds retain both connection drafts and stable model entry IDs', async () => {
  const { controller: c, get, inputs } = fixture(); await c.load();
  c.edit('a'); c.edit('b'); c.patch('a', { displayName: 'A 草稿' }); c.patch('b', { displayName: 'B 草稿' });
  c.toggleModel('a', 'm'); c.patchEntry('a', 'm', { modelID: 'new-api-id' });
  c.toggleConnection('a'); assert.equal(get().expanded.has('a'), false);
  c.toggleConnection('a'); assert.equal(get().expandedModels.get('a')?.has('m'), true);
  await c.save('a');
  assert.equal(get().drafts.has('a'), false); assert.equal(get().drafts.get('b')?.edit.displayName, 'B 草稿');
  const payload = inputs[0]![1] as Parameters<ModelsBridge['save']>[0];
  assert.equal(payload.expectedRevision, 1); assert.deepEqual(payload.credential, { kind: 'keep' });
  assert.equal(payload.connection.models[0]!.entryID, 'm'); assert.equal(payload.connection.models[0]!.modelID, 'new-api-id');
  assert.equal(payload.connection.defaultModelEntryID, 'm');
});

test('defaults and deletes operate on saved versions and require explicit replacements', async () => {
  const { controller: c, get, inputs } = fixture(); await c.load();
  c.edit('a'); c.patch('a', { defaultModelEntryID: 'n' });
  await c.setDefault('a');
  assert.deepEqual(inputs[0], ['default', { expectedRevision: 3, connectionID: 'a', entryID: 'm' }]);
  c.removeEntry('a', 'n'); assert.equal(get().drafts.get('a')?.edit.models.length, 2);
  c.removeEntry('a', 'n', 'm'); assert.equal(get().drafts.get('a')?.edit.defaultModelEntryID, 'm');
  await c.remove('a'); assert.equal(inputs.length, 1);
  await c.remove('a', 'b'); assert.deepEqual(inputs[1], ['remove', { expectedRevision: 1, connectionID: 'a', replacementDefault: 'b' }]);
});

test('changing protocol confirms removal of incompatible options, never overwrites a manual address or follows with a saved Key', async () => {
  const seeded = initial(); seeded.connections[0]!.compatibility.outputTokenField = 'max_tokens'; seeded.connections[0]!.credentialState = 'reference-present';
  const { controller: c, get, inputs } = fixture({ list: async () => good(seeded) }); await c.load(); c.edit('a');
  c.changeProtocol('a', 'anthropic'); assert.equal(get().drafts.get('a')?.edit.apiProtocol, 'chat-completions');
  c.confirmProtocol('a');
  assert.equal(get().drafts.get('a')?.edit.apiProtocol, 'anthropic'); assert.deepEqual(get().drafts.get('a')?.edit.compatibility, {});
  assert.equal(get().drafts.get('a')?.edit.baseURL, 'https://example.invalid/v1');
  await c.save('a'); assert.equal(inputs.length, 0);
  c.detachKey('a', true); await c.save('a');
  assert.deepEqual((inputs[0]![1] as Parameters<ModelsBridge['save']>[0]).credential, { kind: 'remove' });
});

test('new drafts start with explicit protocol and stable IDs and never send a Key value through the bridge', async () => {
  const { controller: c, get, inputs } = fixture(); await c.load();
  const id = c.add('openai')!; const draft = get().drafts.get(id)!.edit;
  assert.equal(draft.apiProtocol, 'responses'); assert.notEqual(id, draft.defaultModelEntryID);
  c.patchEntry(id, draft.defaultModelEntryID, { modelID: 'manual-model', displayName: '手工目录' });
  await c.save(id, true);
  assert.equal(inputs[0]?.[0], 'key'); assert.deepEqual(Object.keys(inputs[0]![1] as object).sort(), ['connection', 'expectedRevision']);
  assert.equal(get().drafts.has(id), true);
  await c.save(id); assert.equal(get().drafts.has(id), false);
});

test('unknown write outcome blocks retry; refresh keeps the draft and stale revisions need explicit reload', async () => {
  let state = initial();
  const { controller: c, get } = fixture({ list: async () => good(state), save: async () => bad('write_outcome_unknown') });
  await c.load(); c.edit('a'); c.patch('a', { displayName: '待核对' }); await c.save('a');
  assert.equal(get().needsRefresh, true); assert.equal(get().drafts.get('a')?.edit.displayName, '待核对');
  state = { ...state, revision: 4, connections: [connection('a', 4), connection('b', 2)] };
  await c.load(); assert.equal(get().needsRefresh, false); assert.equal(c.stale('a'), true);
  assert.equal(get().drafts.get('a')?.edit.displayName, '待核对');
  await c.save('a'); assert.equal(get().needsRefresh, false);
  c.reloadDraft('a'); assert.equal(c.stale('a'), false); assert.equal(get().drafts.get('a')?.expectedRevision, 4);
});

test('failure to read the configuration cannot appear as an empty or editable workspace', async () => {
  const { controller: c, get } = fixture({ list: async () => bad('storage_unavailable') }); await c.load();
  assert.equal(get().configuration, undefined); assert.equal(c.add('custom'), undefined);
  const html = renderToStaticMarkup(createElement(ModelPage, { controller: c }));
  assert.match(html, /重新读取/); assert.doesNotMatch(html, /还没有服务连接/);
});

test('offline markup has two keyboard-accessible expansion levels, no secret input and no online actions', async () => {
  const { controller: c } = fixture(); await c.load(); c.edit('a'); c.toggleModel('a', 'm');
  const html = renderToStaticMarkup(createElement(ModelPage, { controller: c }));
  assert.match(html, /aria-expanded="true"/); assert.match(html, /模型 API ID/); assert.match(html, /从剪贴板保存/);
  assert.match(html, /获取模型列表[^<]*<\/button>/); assert.doesNotMatch(html, /type="password"|role="dialog"|mcred-v1|已连接/);
});


test('a readable manifest after indeterminate publication is read-only until the local service restarts', async () => {
  let blocked = false, writes = 0;
  const { controller: c, get } = fixture({ list: async () => ({ ...good(), ...(blocked ? { writesBlocked: true as const } : {}) }),
    save: async () => { writes++; blocked = true; return bad('publication_uncertain'); } });
  await c.load(); c.edit('a'); c.patch('a', { displayName: '不能丢弃的草稿' }); await c.save('a');
  assert.equal(get().requiresRestart, true);
  await c.load(); assert.equal(get().configuration?.revision, 3); assert.equal(get().requiresRestart, true);
  assert.equal(get().drafts.get('a')?.edit.displayName, '不能丢弃的草稿');
  await c.save('a'); assert.equal(writes, 1);
  const html = renderToStaticMarkup(createElement(ModelPage, { controller: c }));
  assert.match(html, /重启前只读/);
});

test('leaving the model page cancels a prepared Key save once and retains the draft', async () => {
  let finish!: (reply: ModelWorkspaceReply) => void, cancels = 0;
  const { controller: c, get } = fixture({ prepareKeySave: () => new Promise(resolve => { finish = resolve; }), cancelKeySave: async () => { cancels++; } });
  await c.load(); c.edit('a'); c.patch('a', { displayName: '跨页草稿' });
  const pending = c.save('a', true);
  c.leave(); c.leave(); assert.equal(cancels, 1);
  finish(bad('key_input_cancelled')); await pending;
  assert.equal(get().drafts.get('a')?.edit.displayName, '跨页草稿');
});

test('deleting a saved connection with an older revision works against the isolated configuration service', { skip: process.platform === 'win32' }, async t => {
  const { mkdtemp, realpath, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { ModelManagement } = await import('../../app-service/src/models/management.ts');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pet-model-ui-revisions-')));
  const service = new ModelManagement(root, undefined);
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  for (const id of ['a', 'b']) {
    const { credentialState: _status, revision: _revision, ...edit } = connection(id, 0);
    assert.equal((await service.run('save', { connection: edit, expectedRevision: 0, credential: { kind: 'keep' } })).ok, true);
  }
  assert.equal((await service.run('default', { expectedRevision: 2, connectionID: 'a', entryID: 'm' })).ok, true);
  const { controller: c, get } = fixture({ list: () => service.run('list', undefined), remove: input => service.run('remove', input) });
  await c.load(); assert.equal(get().configuration?.revision, 3); assert.equal(get().configuration?.connections[0]?.revision, 1);
  await c.remove('a', 'b');
  assert.equal(get().configuration?.defaultConnectionID, 'b'); assert.deepEqual(get().configuration?.connections.map(item => item.id), ['b']);
});

const discovered = (ids = ['m', 'new/model']): ModelDiscoveryReply => ({ version: 1, ok: true, connectionID: 'a', revision: 1, truncated: true,
  candidates: ids.map(modelID => ({ modelID, displayName: `Remote ${modelID}` })) });
const discoverySeed = () => {
  const value = initial();
  value.connections[0]!.credentialState = 'reference-present';
  value.connections[0]!.models[0] = { ...entry('m'), displayName: '人工名称', contextWindow: 1234, maxOutputTokens: 222, capabilities: { tools: { status: 'supported', source: 'user' } } };
  return value;
};

test('discovery candidates merge into one draft by API ID without overwriting manual metadata or defaults', async () => {
  const seed = discoverySeed(), requests: unknown[] = [];
  const { controller: c, get, inputs } = fixture({ list: async () => good(seed), discover: async input => { requests.push(input); return discovered(); }, cancelDiscovery: async () => {} });
  await c.load(); c.edit('b'); c.patch('b', { displayName: '保留 B 草稿' });
  await c.discover('a');
  assert.deepEqual(requests, [{ connectionID: 'a', expectedRevision: 1, operationID: 'generated-0-1' }]);
  assert.equal(get().discovery?.kind, 'candidates'); assert.equal(get().drafts.has('a'), false);
  c.toggleCandidate('a', 'm'); c.toggleCandidate('a', 'new/model'); c.mergeCandidates('a');
  const draft = get().drafts.get('a')!.edit;
  assert.deepEqual(draft.models[0], seed.connections[0]!.models[0]);
  assert.deepEqual(draft.models.at(-1), { entryID: 'generated-0-2', modelID: 'new/model', displayName: 'Remote new/model', compatibility: {}, capabilities: { tools: { status: 'unknown', source: 'discovery' } } });
  assert.equal(draft.defaultModelEntryID, 'm'); assert.equal(get().configuration?.defaultConnectionID, 'a');
  assert.equal(get().drafts.get('b')?.edit.displayName, '保留 B 草稿'); assert.equal(inputs.length, 0);
  await c.save('a'); assert.equal(inputs[0]?.[0], 'save');
});

test('new, changed-route, and missing-Key drafts cannot discover with a saved Key', async () => {
  let calls = 0;
  const { controller: c } = fixture({ list: async () => good(discoverySeed()), discover: async () => { calls++; return discovered(); }, cancelDiscovery: async () => {} });
  await c.load(); c.edit('a');
  const id = c.add('custom')!; await c.discover(id); await c.discover('b');
  c.patch('a', { baseURL: 'https://other.invalid/v1' }); await c.discover('a');
  c.patch('a', { baseURL: 'https://example.invalid/v1' }); c.detachKey('a', true); await c.discover('a');
  c.detachKey('a', false); c.changeProtocol('a', 'responses'); await c.discover('a');
  c.cancel('a'); c.edit('a'); c.patch('a', { authMode: 'none' }); await c.discover('a');
  assert.equal(calls, 0);
  c.cancel('a'); c.edit('a'); c.patch('a', { displayName: '允许未保存的非路由修改' }); await c.discover('a'); assert.equal(calls, 1);
});

test('cancel, edit, collapse, leave and re-read each invalidate a pending response', async () => {
  for (const action of ['cancel', 'edit', 'collapse', 'leave', 'load']) {
    let done!: (result: ModelDiscoveryReply) => void;
    const cancelled: string[] = [];
    const { controller: c, get } = fixture({ list: async () => good(discoverySeed()), discover: () => new Promise(resolve => { done = resolve; }), cancelDiscovery: async id => { cancelled.push(id); } });
    await c.load(); c.edit('a');
    const pending = c.discover('a');
    if (action === 'cancel') c.cancelDiscovery('a');
    if (action === 'edit') c.patch('a', { displayName: 'new draft' });
    if (action === 'collapse') c.toggleConnection('a');
    if (action === 'leave') c.leave();
    if (action === 'load') await c.load();
    assert.deepEqual(cancelled, ['generated-0-1']);
    done(discovered()); await pending;
    assert.equal(get().discovery, undefined); c.mergeCandidates('a'); assert.equal(get().drafts.get('a')?.edit.models.length, 2);
  }
});

test('candidate capacity overflow does not partially merge and stale results are not actionable', async () => {
  const seed = discoverySeed(); seed.connections[0]!.models.push(...Array.from({ length: 30 }, (_, i) => entry(`manual-${i}`)));
  let reply = discovered(['x', 'y']);
  const { controller: c, get } = fixture({ list: async () => good(seed), discover: async () => reply, cancelDiscovery: async () => {} });
  await c.load(); c.edit('a'); await c.discover('a');
  c.toggleCandidate('a', 'x'); c.toggleCandidate('a', 'y'); c.mergeCandidates('a');
  assert.equal(get().drafts.get('a')?.edit.models.length, 32);
  c.toggleCandidate('a', 'y'); c.mergeCandidates('a'); assert.equal(get().drafts.get('a')?.edit.models.length, 33);
  reply = { ...discovered(['other']), connectionID: 'b' } as ModelDiscoveryReply;
  await c.discover('a'); c.toggleCandidate('a', 'other'); c.mergeCandidates('a');
  assert.equal(get().discovery?.kind, 'error'); assert.equal(get().drafts.get('a')?.edit.models.length, 33);
});

test('inline test requires a second click, pins the draft model, survives folding and discards results on edit', async () => {
  const config = initial(); config.connections[0]!.credentialState = 'reference-present';
  let finish!: (value: import('../../../packages/contracts/src/model-probe.ts').ModelProbeReply) => void;
  const calls: unknown[] = [], cancels: string[] = [];
  const { controller: c, get } = fixture({ list: async () => good(config),
    testConnection: value => { calls.push(value); return new Promise(resolve => { finish = resolve; }); },
    cancelConnectionTest: async id => { cancels.push(id); },
  });
  await c.load(); c.edit('a'); c.patch('a', { defaultModelEntryID: 'n' }); c.patchEntry('a', 'n', { modelID: 'unsaved-id' });
  c.prepareConnectionTest('a'); assert.equal(get().connectionTest?.kind, 'confirm'); assert.equal(calls.length, 0);
  const pending = c.confirmConnectionTest('a');
  assert.equal(get().connectionTest?.kind, 'pending');
  assert.deepEqual(calls[0], { operationID: 'generated-0-1', connectionID: 'a', expectedRevision: 1, entryID: 'n', modelID: 'unsaved-id' });
  c.toggleConnection('a'); assert.equal(get().connectionTest?.kind, 'pending');
  c.patchEntry('a', 'n', { modelID: 'next-id' });
  assert.deepEqual(cancels, ['generated-0-1']);
  finish({ version: 1, ok: true, connectionID: 'a', revision: 1, entryID: 'n' }); await pending;
  assert.equal(get().connectionTest, undefined);
  c.patch('a', { baseURL: 'https://changed.invalid/v1' });
  c.prepareConnectionTest('a'); await c.confirmConnectionTest('a');
  assert.equal(calls.length, 1);
});

test('connection test confirmation is inline, identifies the saved destination and model, and discloses possible charges', async () => {
  const config = initial(); config.connections[0]!.credentialState = 'reference-present';
  const { controller } = fixture({ list: async () => good(config),
    testConnection: async () => { assert.fail('confirmation alone cannot send'); }, cancelConnectionTest: async () => {},
  });
  await controller.load(); controller.edit('a'); controller.patchEntry('a', 'm', { modelID: 'current-draft-model' });
  controller.prepareConnectionTest('a');
  const markup = renderToStaticMarkup(createElement(ModelPage, { controller }));
  assert.match(markup, /aria-label="确认连接测试"/);
  assert.match(markup, /https:\/\/example\.invalid\/v1/);
  assert.match(markup, /current-draft-model/);
  assert.match(markup, /可能产生费用/);
  assert.match(markup, /确认发送一次测试/);
  assert.doesNotMatch(markup, /role="dialog"|<dialog/);
});
