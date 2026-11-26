import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ModelDiscoveryReply, ModelsBridge, ModelWorkspaceReply, SavedModelConfiguration, SavedModelConnection } from '../../../packages/contracts/src/models.ts';
import { ModelWorkspaceController } from '../src/model-state.ts';
import { ModelPage } from '../src/ModelPage.tsx';
import { ModelEditorDialog } from '../src/ModelEditorDialog.tsx';
import { DeleteModelDialog } from '../src/ModelConnectionActions.tsx';

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
    ...overrides,
  };
  const controller = new ModelWorkspaceController(bridge, () => `generated-${inputs.length}-${++next}`);
  let next = 0;
  return { controller, inputs, get: controller.getSnapshot };
}

test('the model page starts with its title followed by a descriptive subtitle', () => {
  const html = renderToStaticMarkup(createElement(ModelPage));
  const header = html.match(/<header class="model-page-header">([\s\S]*?)<\/header>/)?.[1];
  assert.ok(header);
  assert.doesNotMatch(header, /工作区|model-page-crumb/);
  assert.match(header, /<h1[^>]*>模型管理<\/h1><p[^>]*>聊天和弹幕演练默认使用首个已保存的服务商。<\/p>/);
});

test('the model editor offers an empty password input without the clipboard menu workflow', async () => {
  const config = initial(); config.connections[0]!.credentialState = 'reference-present';
  const { controller: c, get } = fixture({ list: async () => good(config) });
  await c.load(); c.edit('a');
  const html = renderToStaticMarkup(createElement(ModelEditorDialog, { editor: { kind: 'edit', id: 'a' },
    state: get(), controller: c, onMode() {}, onClose() {}, onSaved() {} }));
  const keyInput = html.match(/<input\b[^>]*type="password"[^>]*>/)?.[0];
  assert.ok(keyInput);
  assert.match(keyInput, /placeholder="留空保留原凭证"/);
  assert.doesNotMatch(keyInput, /\s(?:disabled|readonly)(?:=|\s|>)/i);
  assert.doesNotMatch(html, /从剪贴板保存|保存剪贴板中的 API Key|type="password"[^>]*value=/);
});

test('a Key is consumed only when a locally valid save is submitted, before invoking the bridge', async () => {
  let submitted = false;
  const { controller: c } = fixture({ save: async input => {
    assert.equal(submitted, true);
    assert.deepEqual(input.credential, { kind: 'replace', key: 'SYNTHETIC-KEY' });
    return good();
  } });
  await c.load(); c.edit('a');
  const onSubmit = () => { submitted = true; };
  c.patch('a', { displayName: '' });
  assert.equal(await c.save('a', 'SYNTHETIC-KEY', undefined, onSubmit), false);
  c.patch('a', { displayName: '新服务商', baseURL: 'http://example.invalid/v1' });
  assert.equal(await c.save('a', 'SYNTHETIC-KEY', undefined, onSubmit), false);
  assert.equal(submitted, false);
  c.patch('a', { baseURL: 'http://127.0.0.1:1234/v1' });
  assert.equal(await c.save('a', 'SYNTHETIC-KEY', undefined, onSubmit), true);
  assert.equal(submitted, true);
});

test('a new Key replaces the bound Key in one save without entering controller state or probing', async () => {
  const config = initial(); config.connections[0]!.credentialState = 'reference-present';
  const key = 'synthetic-entered-key';
  const { controller: c, get, inputs } = fixture({ list: async () => good(config),
    testConnection: async () => assert.fail('ordinary save must not probe'), cancelConnectionTest: async () => {} });
  await c.load(); c.edit('a'); c.patch('a', { baseURL: 'https://another.invalid/v1' });
  assert.equal(await c.save('a'), false); assert.equal(inputs.length, 0);
  assert.equal(await c.save('a', 'invalid key'), false); assert.equal(inputs.length, 0);
  const { edit: connection, expectedRevision } = get().drafts.get('a')!;
  assert.equal(await c.save('a', key), true);
  assert.deepEqual(inputs, [['save', { connection, expectedRevision, credential: { kind: 'replace', key } }]]);
  assert.doesNotMatch(JSON.stringify({ ...get(), drafts: [...get().drafts] }), /synthetic-entered-key/);
});

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

test('the editor retains the connection default but exposes no manual global default controls', async () => {
  const { controller: c, get, inputs } = fixture(); await c.load();
  c.edit('a'); c.patch('a', { defaultModelEntryID: 'n' });
  const html = renderToStaticMarkup(createElement(ModelEditorDialog, { editor: { kind: 'edit', id: 'a' },
    state: get(), controller: c, onMode() {}, onClose() {}, onSaved() {} }));
  assert.match(html, /连接默认模型/);
  assert.doesNotMatch(html, /全局默认/);
  c.removeEntry('a', 'n'); assert.equal(get().drafts.get('a')?.edit.models.length, 2);
  c.removeEntry('a', 'n', 'm'); assert.equal(get().drafts.get('a')?.edit.defaultModelEntryID, 'm');
  assert.deepEqual(inputs, []);
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

test('new drafts start with explicit protocol and stable IDs and can save a not-yet-bound connection', async () => {
  const { controller: c, get, inputs } = fixture(); await c.load();
  const id = c.add('openai')!; const draft = get().drafts.get(id)!.edit;
  assert.equal(draft.apiProtocol, 'responses'); assert.notEqual(id, draft.defaultModelEntryID);
  c.patchEntry(id, draft.defaultModelEntryID, { modelID: 'manual-model', displayName: '手工目录' });
  assert.equal(await c.save(id), true);
  assert.equal(inputs.length, 1);
  assert.deepEqual((inputs[0]![1] as Parameters<ModelsBridge['save']>[0]).credential, { kind: 'keep' });
  assert.equal(get().drafts.has(id), false);
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
  assert.match(html, /重新读取/); assert.doesNotMatch(html, /尚未添加服务商配置/);
});

test('a loaded empty provider list has one setup action and keeps read-only or unavailable states distinct', async () => {
  const configuration = { revision: 0, defaultConnectionID: null, connections: [] };
  const current = (writesBlocked = false) => fixture({ list: async () => ({ version: 1, ok: true, configuration, writesBlocked: writesBlocked ? true : undefined }) }).controller;
  const render = (c?: ModelWorkspaceController) => renderToStaticMarkup(createElement(ModelPage, { controller: c }));
  const c = current();
  assert.doesNotMatch(render(c), /model-empty-state/);
  assert.doesNotMatch(render(), /model-empty-state|添加配置/);
  await c.load();
  const empty = render(c);
  assert.match(empty, /class="model-empty-state"/);
  assert.match(empty, /<h3>尚未添加服务商配置<\/h3>/);
  assert.doesNotMatch(empty, /选择第三方模型提供商或自定义模型 API，配置完成后即可在聊天中选用。/);
  assert.equal((empty.match(/添加配置<\/button>/g) ?? []).length, 1);
  assert.doesNotMatch(empty, /disabled=""[^>]*>.*?添加配置<\/button>/);
  const header = empty.match(/<div class="model-list-header">([\s\S]*?)<\/div>/)?.[1];
  assert.ok(header);
  assert.match(header, /<h2>已配置的服务商<\/h2>[\s\S]*class="button primary model-add-config"/);
  assert.doesNotMatch(empty, /重新读取服务商列表|model-icon/);
  const locked = current(true); await locked.load();
  assert.match(render(locked), /model-add-config" disabled=""/);
});


test('reopening model management refreshes saved providers and keeps unfinished drafts', async () => {
  let saved = initial();
  let reads = 0;
  const { controller: c, get } = fixture({ list: async () => { reads++; return good(saved); } });
  await c.open();
  assert.equal(reads, 1);
  c.edit('a'); c.patch('a', { displayName: '未保存草稿' });
  saved = { revision: 4, defaultConnectionID: 'a', connections: [connection('a', 3), connection('b', 4)] };
  await c.open();
  assert.equal(reads, 2);
  assert.equal(get().drafts.get('a')?.edit.displayName, '未保存草稿');
  assert.equal(c.stale('a'), true);
});

test('both Ape-aligned add categories expose a default-off probe option, disabled for an invalid endpoint', async () => {
  const { controller: c, get } = fixture({ testConnection: async () => assert.fail('render must not probe'), cancelConnectionTest: async () => {} }); await c.load();
  const provider = c.add('deepseek')!, custom = c.add('custom')!;
  c.selectProvider(provider, 'deepseek');
  const render = (mode: 'provider' | 'custom') => renderToStaticMarkup(createElement(ModelEditorDialog, {
    editor: { kind: 'add', mode, provider, custom }, state: get(), controller: c,
    onMode() {}, onClose() {}, onSaved() {},
  }));
  const providerHtml = render('provider'), customHtml = render('custom');
  for (const html of [providerHtml, customHtml]) {
    assert.match(html, /第三方模型提供商/); assert.match(html, /自定义模型 API/); assert.match(html, />服务商<\/span>/);
    assert.doesNotMatch(html, /服务商预设|自定义 API/);
  }
  assert.match(customHtml, /placeholder="输入服务商名称"/);
  assert.match(providerHtml, /model-test-option"><input type="checkbox"\/>保存后测试连接/);
  assert.match(customHtml, /model-test-option"><input type="checkbox" disabled=""\/>保存后测试连接/);
  c.patch(custom, { baseURL: 'http://insecure.invalid/v1' });
  assert.match(render('custom'), /model-test-option"><input type="checkbox" disabled=""\/>保存后测试连接/);
  c.patch(custom, { baseURL: 'https://custom.invalid/v1' });
  assert.match(render('custom'), /model-test-option"><input type="checkbox"\/>保存后测试连接/);
});

test('model management renders one row per saved connection even when provider names match, without exposing model details', async () => {
  const config = initial();
  config.connections[1]!.displayName = config.connections[0]!.displayName;
  config.connections[0]!.models[0] = { ...entry('private-model-id'), entryID: 'm', displayName: '藏在弹窗的模型' };
  const { controller: c } = fixture({ list: async () => good(config) }); await c.load(); c.edit('a'); c.patchEntry('a', 'm', { displayName: '未保存的名称' }); c.add('custom');
  const html = renderToStaticMarkup(createElement(ModelPage, { controller: c }));
  assert.match(html, /aria-label="服务商列表"/); assert.match(html, /添加配置/);
  assert.equal((html.match(/class="button primary model-add-config"/g) ?? []).length, 1);
  const header = html.match(/<div class="model-list-header">([\s\S]*?)<\/div>/)?.[1];
  assert.ok(header); assert.match(header, /<h2>已配置的服务商<\/h2>[\s\S]*class="button primary model-add-config"/);
  assert.doesNotMatch(html, /重新读取服务商列表|class="model-icon"/);
  assert.equal((html.match(/<li class="model-row"/g) ?? []).length, 2);
  assert.equal((html.match(/<strong>连接 a<\/strong>/g) ?? []).length, 2);
  assert.doesNotMatch(html, /更多操作/);
  assert.doesNotMatch(html, /服务商预设|自定义 API/);
  assert.match(html, /aria-label="删除 连接 a">删除<\/button>/);
  assert.doesNotMatch(html, /藏在弹窗的模型|private-model-id|未保存的名称|Chat Completions|type="password"|mcred-v1/);
});

test('the status button next to the service name reports only the saved default model on its current revision', async () => {
  let config = initial();
  config.connections[0]!.credentialState = 'reference-present';
  const probes: Parameters<NonNullable<ModelsBridge['testConnection']>>[0][] = [];
  let fail = true;
  const { controller: c, inputs } = fixture({ list: async () => good(config), testConnection: async input => {
    probes.push(input);
    if (input.entryID === 'm' && fail) return { version: 1, ok: false, error: 'rate_limited' };
    return { version: 1, ok: true, connectionID: input.connectionID, revision: input.expectedRevision, entryID: input.entryID };
  }, cancelConnectionTest: async () => {} });
  const render = () => renderToStaticMarkup(createElement(ModelPage, { controller: c }));
  const status = (state: string, label: string) => new RegExp(`<strong>连接 a</strong><button[^>]*data-status="${state}"[^>]*aria-label="测试连接 连接 a：${label}[^>]*>`);
  await c.load();
  assert.match(render(), status('untested', '未测试'));
  const untestedWithoutKey = render().match(/<button[^>]*aria-label="测试连接 连接 b：未测试"[^>]*>/)?.[0];
  assert.ok(untestedWithoutKey);
  assert.doesNotMatch(untestedWithoutKey, /aria-disabled|保存 API Key/);
  assert.match(render(), /点击发送一次短测试，可能产生费用/);
  assert.equal(probes.length, 0);
  c.prepareConnectionTest('a', 'n'); await c.confirmConnectionTest('a');
  assert.match(render(), status('untested', '未测试'));
  assert.equal((await c.testSavedDefault('a', 1))?.ok, false);
  assert.match(render(), status('failed', '测试失败'));
  assert.match(render(), /限制了请求频率/);
  assert.match(render(), /点击重新测试连接，可能产生费用/);
  fail = false;
  assert.equal((await c.testSavedDefault('a', 1))?.ok, true);
  assert.match(render(), status('ok', '测试成功'));
  assert.equal(probes.length, 3);
  const { operationID: first, ...firstInput } = probes[1]!;
  const { operationID: retry, ...retryInput } = probes[2]!;
  assert.notEqual(first, retry);
  assert.deepEqual(retryInput, firstInput);
  assert.deepEqual(inputs, []);
  config = { ...config, revision: 4, connections: [{ ...config.connections[0]!, revision: 4 }, config.connections[1]!] };
  await c.load();
  assert.match(render(), status('untested', '未测试'));
});

test('a test without a confirmed outcome explains why the dot did not change, without replacing prior evidence', async () => {
  const input = { connectionID: 'a', expectedRevision: 1, entryID: 'm', modelID: 'm' };
  let listing = good();
  const { controller: c } = fixture({ list: async () => listing,
    testConnection: async () => ({ version: 1, ok: false, error: 'credentials_unavailable' }), cancelConnectionTest: async () => {} });
  const render = () => renderToStaticMarkup(createElement(ModelPage, { controller: c }));
  await c.load();
  await c.testSavedDefault('a', 1);
  assert.match(render(), /data-status="untested"[^>]*aria-label="测试连接 连接 a：未测试/);
  assert.match(render(), /role="alert">连接 a：本次测试未确认，状态保持不变。无法读取此连接的 Key/);

  listing = { version: 1, ok: true, configuration: initial(), probeResults: [{ input, testedAt: '2026-11-24T00:00:00.000Z',
    result: { version: 1, ok: true, connectionID: 'a', revision: 1, entryID: 'm' } }] };
  c.leave();
  await c.load();
  assert.doesNotMatch(render(), /role="alert">连接 a：本次测试未确认/);
  await c.testSavedDefault('a', 1);
  assert.match(render(), /data-status="ok"[^>]*aria-label="测试连接 连接 a：测试成功/);
  assert.match(render(), /role="alert">连接 a：本次测试未确认/);
});

test('testing the saved default without a Key sends once and rejects drafts, stale revisions and overlapping tests', async () => {
  const config = initial();
  const saved = config.connections[0]!;
  saved.defaultModelEntryID = 'n';
  let finish!: (reply: import('../../../packages/contracts/src/model-probe.ts').ModelProbeReply) => void;
  const probes: Parameters<NonNullable<ModelsBridge['testConnection']>>[0][] = [];
  const { controller: c } = fixture({ list: async () => good(config), testConnection: input => { probes.push(input); return new Promise(resolve => { finish = resolve; }); },
    cancelConnectionTest: async () => {} });
  await c.load();
  assert.equal(await c.testSavedDefault('a', 0), undefined);
  assert.equal(await c.testSavedDefault('b', 1), undefined);
  c.edit('a'); c.patch('a', { defaultModelEntryID: 'm' });
  assert.equal(await c.testSavedDefault('a', 1), undefined);
  c.cancel('a'); assert.equal(probes.length, 0);
  const pending = c.testSavedDefault('a', 1);
  assert.equal(await c.testSavedDefault('a', 1), undefined);
  assert.equal(probes.length, 1);
  assert.deepEqual(probes[0], { connectionID: 'a', expectedRevision: 1, entryID: 'n', modelID: 'n', operationID: 'generated-0-1' });
  const html = renderToStaticMarkup(createElement(ModelPage, { controller: c }));
  assert.match(html, /aria-disabled="true"[^>]*aria-label="测试连接 连接 a：测试中/);
  finish({ version: 1, ok: true, connectionID: 'a', entryID: 'n', revision: 1 });
  assert.equal((await pending)?.ok, true);
});

test('editing a connection exposes all saved models behind one collapsed parameter section with no removal shortcut', async () => {
  const { controller: c, get } = fixture(); await c.load(); c.edit('a');
  const html = renderToStaticMarkup(createElement(ModelEditorDialog, { editor: { kind: 'edit', id: 'a' },
    state: get(), controller: c, onMode: () => {}, onClose: () => {}, onSaved: () => {} }));
  assert.match(html, /编辑配置/); assert.match(html, /aria-expanded="false"[^>]*>.*?模型参数/);
  assert.equal((html.match(/aria-label="模型 [12]"/g) ?? []).length, 2);
  assert.match(html, /再添加一个模型/); assert.doesNotMatch(html, /aria-label="移除模型/);
});

test('the Responses editor keeps existing controls without exposing input types or tool capability', async () => {
  const config = initial();
  const saved = config.connections[0]!;
  saved.apiProtocol = 'responses';
  saved.baseURL = 'https://api.openai.com/v1';
  saved.models[0]!.modelID = 'gpt-6.2-astra';
  saved.models[0]!.inputModalities = ['image'];
  const { controller, get } = fixture({ list: async () => good(config) });
  await controller.load(); controller.edit('a');
  const html = renderToStaticMarkup(createElement(ModelEditorDialog, { editor: { kind: 'edit', id: 'a' },
    state: get(), controller, onMode() {}, onClose() {}, onSaved() {} }));
  assert.doesNotMatch(html, /连接选项与高级设置/);
  assert.doesNotMatch(html, /鉴权方式|缺少 Key/);
  assert.match(html, /API Key（选填）/);
  assert.match(html, /连接默认模型/);
  assert.doesNotMatch(html, /输入类型|支持图片输入|支持 PDF 输入|工具能力|最大输出 Token/);
  assert.match(html, /思考深度/);
  assert.match(html, /已保存连接/);
  assert.equal((html.match(/class="model-custom"/g) ?? []).length, 1);

  const css = readFileSync(resolve('apps/workspace-ui/src/models.css'), 'utf8');
  assert.match(css, /\.model-dialog\s*\{[^}]*width:\s*min\(480px,\s*100% - 24px\)/s);
  assert.match(css, /\.model-dialog\s*\{[^}]*max-height:\s*min\(520px,/s);
  assert.match(css, /\.model-dialog-layout[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*max-height:\s*min\(520px,/s);
  assert.match(css, /\.model-dialog-scroll[^}]*overflow:\s*auto/s);
  assert.match(css, /@media\s*\(max-width:\s*530px\)\s*\{[^}]*\.model-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
});

test('neither Chat Completions compatibility field is shown; saving ordinary edits preserves hidden model metadata', async () => {
  const config = initial();
  const cc = config.connections[0]!;
  cc.compatibility = { outputTokenField: 'max_tokens' };
  cc.models[0]!.compatibility = { outputTokenField: 'max_completion_tokens' };
  cc.models[0]!.capabilities = { tools: { status: 'supported', source: 'user' } };
  const responses = config.connections[1]!;
  responses.apiProtocol = 'responses';
  responses.models[0]!.inputModalities = ['image', 'pdf'];
  const submissions: Parameters<ModelsBridge['save']>[0][] = [];
  const { controller, get } = fixture({ list: async () => good(config), save: async input => {
    submissions.push(input);
    const revision = config.revision + submissions.length;
    return good({ ...config, revision, connections: config.connections.map(c => c.id === input.connection.id
      ? { ...c, ...input.connection, revision } : c) });
  } });
  await controller.load(); controller.edit('a');
  const html = renderToStaticMarkup(createElement(ModelEditorDialog, { editor: { kind: 'edit', id: 'a' },
    state: get(), controller, onMode() {}, onClose() {}, onSaved() {} }));
  assert.doesNotMatch(html, /输出 Token 字段|max_completion_tokens|max_tokens|工具能力|输入类型/);
  assert.doesNotMatch(html, /最大输出 Token/);
  controller.patch('a', { displayName: '服务商新名称' });
  assert.equal(await controller.save('a'), true);
  assert.deepEqual(submissions[0]?.connection.compatibility, cc.compatibility);
  assert.deepEqual(submissions[0]?.connection.models, cc.models);
  controller.edit('b');
  controller.patchEntry('b', 'm', { displayName: '模型新名称' });
  assert.equal(await controller.save('b'), true);
  assert.deepEqual(submissions[1]?.connection.models[0]?.inputModalities, ['image', 'pdf']);
});

test('changing a model identity clears reasoning and modality choices from the prior identity', async () => {
  const config = initial();
  const saved = config.connections[0]!;
  saved.apiProtocol = 'responses'; saved.baseURL = 'https://api.openai.com/v1';
  saved.models[0]!.modelID = 'gpt-6.2-astra';
  saved.models[0]!.reasoningEffort = 'high'; saved.models[0]!.inputModalities = ['image'];
  const { controller } = fixture({ list: async () => good(config) });
  await controller.load(); controller.edit('a');
  controller.patchEntry('a', 'm', { modelID: 'other-model' });
  let model = controller.getSnapshot().drafts.get('a')!.edit.models[0]!;
  assert.equal(model.reasoningEffort, undefined); assert.equal(model.inputModalities, undefined);

  controller.patchEntry('a', 'm', { modelID: 'gpt-6.2-astra', reasoningEffort: 'high', inputModalities: ['image'] });
  controller.patch('a', { baseURL: 'https://gateway.example/v1' });
  model = controller.getSnapshot().drafts.get('a')!.edit.models[0]!;
  assert.equal(model.reasoningEffort, undefined); assert.equal(model.inputModalities, undefined);
});

test('a changed endpoint, model ID or protocol never inherits the old tool confirmation', async () => {
  const config = initial();
  config.connections[0]!.models[0]!.capabilities.tools = { status: 'supported', source: 'user' };
  const { controller: c, get } = fixture({ list: async () => good(config) });
  await c.load();
  const inspect = () => get().drafts.get('a')!.edit.models[0]!.capabilities.tools.status;
  for (const change of [() => c.patchEntry('a', 'm', { modelID: 'different-model' }),
    () => c.patch('a', { baseURL: 'https://another.invalid/v1' }), () => c.changeProtocol('a', 'responses')]) {
    c.edit('a');
    c.patch('a', { displayName: '只改名称' });
    assert.equal(inspect(), 'supported');
    change();
    assert.equal(inspect(), 'unknown');
    c.cancel('a');
  }
});

test('changing protocol clears reasoning and modality choices that the new protocol cannot honor', async () => {
  const config = initial();
  const saved = config.connections[0]!;
  saved.apiProtocol = 'responses'; saved.baseURL = 'https://api.openai.com/v1';
  saved.models[0]!.modelID = 'gpt-6.2-astra';
  saved.models[0]!.reasoningEffort = 'high'; saved.models[0]!.inputModalities = ['image'];
  const { controller, get } = fixture({ list: async () => good(config) });
  await controller.load(); controller.edit('a');
  controller.changeProtocol('a', 'chat-completions');
  const model = get().drafts.get('a')!.edit.models[0]!;
  assert.equal(model.reasoningEffort, undefined);
  assert.equal(model.inputModalities, undefined);
});

test('deleting the last saved model requires confirmation but no global replacement choice', async () => {
  const config = initial();
  const saved = config.connections[0]!;
  saved.models.pop();
  const { controller: c, get } = fixture({ list: async () => good(config) });
  await c.load();
  const deletion = renderToStaticMarkup(createElement(DeleteModelDialog, { connection: saved, controller: c, state: get(), close: () => {} }));
  assert.match(deletion, /最后一个模型.*?一并移除连接/);
  assert.doesNotMatch(deletion, /全局默认|替代的连接默认模型/);
  assert.doesNotMatch(deletion, /disabled=""[^>]*>确认删除/);
});

test('deleting one model pins the saved revision and replaces a default only on explicit selection', async () => {
  const { controller: c, get, inputs } = fixture(); await c.load();
  assert.equal(await c.deleteModel('a', 0, 'm', 'n'), false);
  assert.equal(await c.deleteModel('a', 1, 'm'), false);
  assert.equal(inputs.length, 0);
  assert.equal(await c.deleteModel('a', 1, 'm', 'n'), true);
  const input = inputs[0]![1] as Parameters<ModelsBridge['save']>[0];
  assert.equal(input.expectedRevision, 1); assert.equal(input.connection.defaultModelEntryID, 'n');
  assert.deepEqual(input.connection.models.map(item => item.entryID), ['n']);
  assert.deepEqual(input.credential, { kind: 'keep' });
  assert.equal(get().configuration?.defaultConnectionID, 'a');
});

test('last-model removal clears a legacy reference without asking for a fallback or saving an empty connection', async () => {
  const config = initial(); config.connections[0]!.models.pop();
  const { controller: c, inputs } = fixture({ list: async () => good(config) }); await c.load();
  assert.equal(await c.deleteModel('a', 1, 'm'), true);
  assert.deepEqual(inputs, [['remove', { connectionID: 'a', expectedRevision: 1, replacementDefault: null }]]);
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

test('an uncertain Key save leaves the non-secret draft and requires re-reading before any retry', async () => {
  const { controller: c, get } = fixture({ save: async () => bad('write_outcome_unknown') });
  await c.load(); c.edit('a'); c.patch('a', { displayName: '保留的配置草稿' });
  assert.equal(await c.save('a', 'synthetic-uncertain-key'), false);
  assert.equal(get().drafts.get('a')?.edit.displayName, '保留的配置草稿');
  assert.equal(get().needsRefresh, true);
  assert.doesNotMatch(JSON.stringify({ ...get(), drafts: [...get().drafts] }), /synthetic-uncertain-key/);
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
  await c.remove('a');
  assert.equal(get().configuration?.defaultConnectionID, null); assert.deepEqual(get().configuration?.connections.map(item => item.id), ['b']);
  assert.deepEqual((await service.listChatModels()).filter(item => item.isDefault).map(item => item.route.connectionID), ['b']);
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

test('discovery accepts saved connections without a Key, but not unsaved address, protocol or Key detach', async () => {
  let calls = 0;
  const { controller: c } = fixture({ list: async () => good(discoverySeed()), discover: async () => { calls++; return discovered(); }, cancelDiscovery: async () => {} });
  await c.load(); c.edit('a');
  const id = c.add('custom')!; await c.discover(id);
  assert.equal(c.discoveryBlockedReason('b'), undefined);
  c.patch('a', { baseURL: 'https://other.invalid/v1' }); await c.discover('a');
  c.patch('a', { baseURL: 'https://example.invalid/v1' }); c.detachKey('a', true); await c.discover('a');
  c.detachKey('a', false); c.changeProtocol('a', 'responses'); await c.discover('a');
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

test('per-model testing pins the selected saved row instead of the connection default', async () => {
  const config = initial(); config.connections[0]!.credentialState = 'reference-present';
  const requests: import('../../../packages/contracts/src/model-probe.ts').ModelProbeOperation[] = [];
  const { controller: c } = fixture({ list: async () => good(config), testConnection: async input => {
    requests.push(input); return { version: 1, ok: true, connectionID: input.connectionID, revision: input.expectedRevision, entryID: input.entryID };
  }, cancelConnectionTest: async () => {} });
  await c.load(); c.prepareConnectionTest('a', 'n'); assert.equal(requests.length, 0);
  await c.confirmConnectionTest('a'); assert.equal(requests[0]?.entryID, 'n'); assert.equal(requests[0]?.expectedRevision, 1);
});

test('post-save batch tests require explicit opt-in and a confirmed write, and pin each saved model', async () => {
  for (const [optIn, fails] of [[false, false], [true, true], [true, false]]) {
    const requests: string[] = [];
    const { controller: c } = fixture({ save: async input => fails ? bad('write_outcome_unknown') : good({ ...initial(), connections: [
      { ...input.connection, credentialState: 'reference-present', revision: 9 },
    ] }), testConnection: async input => {
      assert.equal(input.expectedRevision, 9); requests.push(input.entryID);
      return { version: 1, ok: true, connectionID: input.connectionID, revision: 9, entryID: input.entryID };
    }, cancelConnectionTest: async () => {} });
    await c.load(); c.edit('a');
    assert.equal(await c.save('a', 'synthetic-test-key', optIn ? ['m', 'n'] : undefined), !fails);
    assert.deepEqual(requests, optIn && !fails ? ['m', 'n'] : []);
  }
});

test('an explicitly approved post-save batch checks the saved default before another model can stop the batch', async () => {
  const requests: string[] = [];
  const { controller: c } = fixture({ save: async input => good({ ...initial(), connections: [
    { ...input.connection, credentialState: 'missing', revision: 9 },
  ] }), testConnection: async input => {
    requests.push(input.entryID);
    return input.entryID === 'm' ? { version: 1, ok: false, error: 'provider_not_found' }
      : { version: 1, ok: true, connectionID: 'a', revision: 9, entryID: 'n' };
  }, cancelConnectionTest: async () => {} });
  await c.load();
  c.edit('a');
  c.patch('a', { defaultModelEntryID: 'n' });
  assert.equal(await c.save('a', '', ['m', 'n']), true);
  assert.deepEqual(requests, ['n', 'm']);
  const html = renderToStaticMarkup(createElement(ModelPage, { controller: c }));
  assert.match(html, /data-status="ok"[^>]*aria-label="测试连接 连接 a：测试成功/);
});

test('a new local connection can save and explicitly test with a blank Key', async () => {
  const probes: string[] = [];
  const { controller: c, inputs } = fixture({ testConnection: async input => {
    probes.push(input.entryID);
    return { version: 1, ok: true, connectionID: input.connectionID, revision: input.expectedRevision, entryID: input.entryID };
  }, cancelConnectionTest: async () => {} });
  await c.load();
  const id = c.add('custom')!;
  c.patch(id, { baseURL: 'http://127.0.0.1:11434/v1' });
  const { edit, expectedRevision } = c.getSnapshot().drafts.get(id)!;
  c.patchEntry(id, edit.defaultModelEntryID, { modelID: 'local-model', displayName: '本地模型' });
  assert.equal(await c.save(id, '', [edit.defaultModelEntryID]), true);
  assert.deepEqual(probes, [edit.defaultModelEntryID]);
  assert.deepEqual(inputs, [['save', { connection: { ...edit, models: [{ ...edit.models[0]!, modelID: 'local-model', displayName: '本地模型' }] }, expectedRevision, credential: { kind: 'keep' } }]]);
});

test('legacy no-auth connections still show the optional password field and can bind a Key', async () => {
  const config = initial();
  const saved = config.connections[0]!;
  Object.assign(saved, { authMode: 'none', credentialState: 'not-required', baseURL: 'http://127.0.0.1:11434/v1' });
  const { controller: c, inputs, get } = fixture({ list: async () => good(config) });
  await c.load(); c.edit('a');
  const html = renderToStaticMarkup(createElement(ModelEditorDialog, { editor: { kind: 'edit', id: 'a' },
    state: get(), controller: c, onMode() {}, onClose() {}, onSaved() {} }));
  assert.doesNotMatch(html, /鉴权方式|缺少 Key/);
  assert.match(html, /<input\b[^>]*type="password"/);
  const { edit, expectedRevision } = get().drafts.get('a')!;
  assert.equal(await c.save('a', 'synthetic-key'), true);
  assert.deepEqual(inputs, [['save', { connection: { ...edit, authMode: 'apiKey' }, expectedRevision, credential: { kind: 'replace', key: 'synthetic-key' } }]]);
});

test('provider and custom drafts can share the last new-connection slot without sharing fields', async () => {
  const { controller: c, get } = fixture({ list: async () => good({ revision: 1, defaultConnectionID: null, connections: Array.from({ length: 31 }, (_, i) => connection(`saved-${i}`, 1)) }) });
  await c.load();
  const vendor = c.add('deepseek')!; c.selectProvider(vendor, 'deepseek');
  const custom = c.add('custom', vendor)!; c.patch(custom, { displayName: '自定义草稿', baseURL: 'https://custom.invalid/v1' });
  c.selectProvider(vendor, 'qwen');
  assert.equal(get().drafts.get(vendor)?.provider, 'qwen');
  assert.equal(get().drafts.get(vendor)?.edit.displayName, '阿里云百炼 · 通义千问');
  assert.equal(get().drafts.get(custom)?.edit.baseURL, 'https://custom.invalid/v1');
  assert.equal(c.add('openai'), undefined);
});

test('leaving before save settles prevents any post-save connection test', async () => {
  let confirm!: (reply: ModelWorkspaceReply) => void;
  const { controller: c } = fixture({ save: () => new Promise(resolve => { confirm = resolve; }),
    testConnection: async () => { assert.fail('a departed editor must not send'); }, cancelConnectionTest: async () => {} });
  await c.load(); c.edit('a');
  const pending = c.save('a', 'synthetic-test-key', ['m']); c.leave();
  const saved = initial(); saved.connections[0]!.credentialState = 'reference-present';
  confirm(good(saved)); assert.equal(await pending, true);
});


test('reloading model management restores saved-version probe status without re-testing', async () => {
  const input = { connectionID: 'a', expectedRevision: 1, entryID: 'm', modelID: 'm' };
  const result = { version: 1 as const, ok: true as const, connectionID: 'a', revision: 1, entryID: 'm' };
  let calls = 0;
  const { controller: c, get } = fixture({ list: async () => ({ ...good(), probeResults: [{ input, result, testedAt: '2026-11-24T00:00:00.000Z' }] }),
    testConnection: async () => { calls++; return result; }, cancelConnectionTest: async () => {} });
  await c.load();
  assert.deepEqual(get().probeResults?.get(JSON.stringify(['a', 'm']))?.result, result);
  assert.equal(calls, 0);
});

test('draft model evidence and obsolete revisions cannot mark a saved default as tested', async () => {
  for (const input of [
    { connectionID: 'a', expectedRevision: 1, entryID: 'm', modelID: 'unsaved-model' },
    { connectionID: 'a', expectedRevision: 2, entryID: 'm', modelID: 'm' },
    { connectionID: 'a', expectedRevision: 1, entryID: 'm', modelID: 'm', maxOutputTokens: 32 },
  ]) {
    const { controller, get } = fixture({ list: async () => ({ ...good(), probeResults: [{ input, testedAt: '2026-11-24T00:00:00.000Z',
      result: { version: 1, ok: true, connectionID: 'a', revision: input.expectedRevision, entryID: 'm' } }] }) });
    await controller.load();
    assert.equal(get().probeResults?.size, 0);
  }
});

test('cancelled or unconfirmed re-tests leave the last confirmed saved-model dot unchanged', async () => {
  const result = { version: 1, ok: true, connectionID: 'a', revision: 1, entryID: 'm' } as const;
  const input = { connectionID: 'a', expectedRevision: 1, entryID: 'm', modelID: 'm' };
  let finish!: (reply: import('../../../packages/contracts/src/model-probe.ts').ModelProbeReply) => void;
  const { controller: c, get } = fixture({ list: async () => ({ ...good(), probeResults: [{ input, result, testedAt: '2026-11-24T00:00:00.000Z' }] }),
    testConnection: () => new Promise(resolve => { finish = resolve; }), cancelConnectionTest: async () => {} });
  const render = () => renderToStaticMarkup(createElement(ModelPage, { controller: c }));
  await c.load();
  const cancelled = c.testSavedDefault('a', 1);
  c.cancelConnectionTest('a', true);
  finish({ version: 1, ok: false, error: 'cancelled' }); await cancelled;
  assert.deepEqual(get().probeResults?.get(JSON.stringify(['a', 'm']))?.result, result);
  assert.match(render(), /已停止等待/);
  for (const error of ['unavailable', 'storage_unavailable', 'busy', 'cancelled'] as const) {
    const pending = c.testSavedDefault('a', 1);
    finish({ version: 1, ok: false, error }); await pending;
    assert.deepEqual(get().probeResults?.get(JSON.stringify(['a', 'm']))?.result, result);
    assert.match(render(), /aria-label="测试连接 连接 a：测试成功/);
  }
});

test('a new list is authoritative for evidence without blocking model edits on a receipt warning', async () => {
  const input = { connectionID: 'a', expectedRevision: 1, entryID: 'm', modelID: 'm' };
  const result = { version: 1, ok: true, connectionID: 'a', revision: 1, entryID: 'm' } as const;
  const configuration = { version: 1, ok: true, configuration: initial() } as const;
  let reply: ModelWorkspaceReply = { ...configuration, probeResults: [{ input, result, testedAt: '2026-11-24T00:00:00.000Z' }] };
  const { controller: c, get } = fixture({ list: async () => reply, testConnection: async () => assert.fail('read must not probe'), cancelConnectionTest: async () => {} });
  const render = () => renderToStaticMarkup(createElement(ModelPage, { controller: c }));
  await c.load(); assert.equal(get().probeResults?.size, 1);
  reply = good(); await c.load(); assert.equal(get().probeResults?.size, 0);
  reply = { ...configuration, probeStorageUnavailable: true }; await c.load();
  assert.match(render(), /连接测试记录暂不可读取/);
  assert.match(render(), /data-status="unavailable"[^>]*aria-label="测试连接 连接 a：状态不可用/);
  assert.ok(c.savedDefaultTestBlockedReason('a', 1));
  c.edit('a'); assert.ok(get().drafts.has('a'));
  reply = good(); await c.load();
  assert.doesNotMatch(render(), /连接测试记录暂不可读取/);
});

test('a newly saved non-global-default connection restores its tested dot from disk after service and UI restarts', { skip: process.platform === 'win32' }, async t => {
  const { mkdtemp, realpath, rm, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { ModelManagement } = await import('../../app-service/src/models/management.ts');
  const { textReply } = await import('../../app-service/test/fixtures/model-replies.ts');
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'pet-model-status-restart-')));
  let calls = 0, status = 200;
  const fetch: typeof globalThis.fetch = async () => {
    calls++;
    return Response.json(status === 200 ? textReply('chat-completions') : {}, { status });
  };
  let service = new ModelManagement(root, undefined, undefined, { fetch });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const bridge: ModelsBridge = {
    list: () => service.run('list', undefined),
    save: input => service.run('save', input),
    setDefault: input => service.run('default', input),
    remove: input => service.run('remove', input),
    testConnection: ({ operationID: _operationID, ...input }) => service.testConnection(input),
    cancelConnectionTest: async () => {},
  };
  const { credentialState: _credentialState, revision: _revision, ...seed } = connection('a', 0);
  const saved = await service.run('save', { connection: seed, expectedRevision: 0, credential: { kind: 'keep' } });
  assert.ok(saved.ok);
  assert.ok((await service.run('default', { expectedRevision: saved.configuration.revision, connectionID: 'a', entryID: 'm' })).ok);
  let controller = fixture(bridge).controller;
  await controller.load();
  const id = controller.add('custom')!;
  controller.patch(id, { displayName: '新增非全局默认服务商', baseURL: 'http://127.0.0.1:11434/v1' });
  const entryID = controller.getSnapshot().drafts.get(id)!.edit.defaultModelEntryID;
  controller.patchEntry(id, entryID, { modelID: 'synthetic-model', displayName: '合成模型' });
  assert.equal(await controller.save(id, '', [entryID]), true);
  assert.equal(controller.getSnapshot().configuration?.defaultConnectionID, 'a');
  const render = () => renderToStaticMarkup(createElement(ModelPage, { controller }));
  const dot = (state: string) => new RegExp(`<strong>新增非全局默认服务商</strong><button[^>]*data-status="${state}"`);
  assert.match(render(), dot('ok'));
  assert.equal(calls, 1);
  const receipt = JSON.parse(await readFile(resolve(root, 'model-probes.json'), 'utf8'));
  assert.equal(receipt.records[0].input.connectionID, id);
  assert.equal(receipt.records[0].result.ok, true);
  const restart = async () => {
    controller.leave();
    await service.close();
    service = new ModelManagement(root, undefined, undefined, { fetch });
    controller = fixture(bridge).controller;
    await controller.load();
  };
  await restart();
  assert.match(render(), dot('ok'));
  assert.equal(calls, 1, 'restoring the saved dot must not contact the provider');
  status = 401;
  const revision = controller.getSnapshot().configuration!.connections.find(value => value.id === id)!.revision;
  assert.equal((await controller.testSavedDefault(id, revision))?.ok, false);
  await restart();
  assert.match(render(), dot('failed'));
  assert.equal(calls, 2);
  controller.edit(id);
  controller.patch(id, { baseURL: 'http://127.0.0.1:11435/v1' });
  assert.equal(await controller.save(id), true);
  await restart();
  assert.match(render(), dot('untested'));
  assert.equal(calls, 2, 'configuration edits and restarts must not silently re-test');
});
