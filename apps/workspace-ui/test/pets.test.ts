import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PetsBridge, PetResult, WorkspaceData, PetInputs } from '../../../packages/contracts/src/pets.ts';
import { PetWorkspaceController, isDraftDirty } from '../src/pet-state.ts';
import { requestPets } from '../src/pet-client.ts';
import { WorkspaceView } from '../src/App.tsx';
import { PetSettings } from '../src/PetSettings.tsx';

const workspace: WorkspaceData = { revision: 0, theme: 'system', catalog: [], maximumRunning: 3, linkage: 'active', instances: [{ id: 'pet-one', package: { id: 'dev.longmei', version: '1.0.0' }, displayName: '小一', enabled: true, autoStartOnLaunch: false, preferences: { size: 200, scheduledActivity: true, movement: false, hideInFullscreen: true }, phase: 'not-connected' }] };
const ok = (value = workspace): PetResult => ({ ok: true, workspace: value });
const bridge = (overrides: Partial<PetsBridge> = {}): PetsBridge => ({ list: async () => ok(), importPackages: async () => ({ ok: true, items: [] }), start: async () => ok(), stop: async () => ok(), applyDisplayPreferences: async () => ok(), applyBehaviorPreferences: async () => ok(), setVisible: async () => ok(), add: async () => ok(), clone: async () => ok(), delete: async () => ok(), save: async () => ok(), setTheme: async () => ok(), pause: async () => ok(), resume: async () => ok(), ...overrides });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

test('pet client fails safely without a bridge, rejects malformed responses and redacts exceptions', async () => {
  assert.deepEqual(await requestPets(undefined, 'list'), { ok: false, error: 'unavailable' });
  assert.deepEqual(await requestPets(bridge({ list: async () => { throw Error('/private/secret'); } }), 'list'), { ok: false, error: 'unavailable' });
  assert.deepEqual(await requestPets(bridge({ list: async () => ({ ok: true, workspace: {} }) as PetResult }), 'list'), { ok: false, error: 'invalid' });
  let writes = 0;
  assert.deepEqual(await requestPets(bridge({ save: async () => { writes++; return ok(); } }), 'save', { expectedRevision: 0, id: 'pet-one', displayName: '', enabled: true, autoStartOnLaunch: false, preferences: workspace.instances[0]!.preferences }), { ok: false, error: 'invalid' });
  assert.equal(writes, 0);
});

test('selection creates an editable draft and save uses the exact versioned input, never runtime control', async () => {
  let input: PetInputs['save'] | undefined;
  const controller = new PetWorkspaceController(bridge({ save: async value => { input = value; return ok({ ...workspace, revision: 1, instances: [{ ...workspace.instances[0]!, displayName: value.displayName, preferences: value.preferences }] }); } }));
  await controller.load();
  assert.equal(controller.getSnapshot().selectedId, 'pet-one');
  controller.edit({ displayName: '新名字', preferences: { ...workspace.instances[0]!.preferences, size: 384 } });
  assert.equal(isDraftDirty(controller.getSnapshot(), 'pet-one'), true);
  await controller.save();
  assert.deepEqual(input, { expectedRevision: 0, id: 'pet-one', displayName: '新名字', enabled: true, autoStartOnLaunch: false, preferences: { size: 384, scheduledActivity: true, movement: false, hideInFullscreen: true } });
  assert.equal(isDraftDirty(controller.getSnapshot(), 'pet-one'), false);
  assert.match(controller.getSnapshot().notice, /已保存.*单独应用/);
});

test('save failure and revision conflict preserve drafts until explicit refresh; refresh retains edits', async () => {
  const controller = new PetWorkspaceController(bridge({ save: async () => ({ ok: false, error: 'conflict' }) }));
  await controller.load(); controller.edit({ displayName: '保留我' }); await controller.save();
  assert.equal(controller.getSnapshot().drafts['pet-one']?.displayName, '保留我');
  assert.equal(controller.getSnapshot().needsRefresh, true);
  assert.equal(await controller.save(), false);
  await controller.load();
  assert.equal(controller.getSnapshot().needsRefresh, false);
  assert.equal(controller.getSnapshot().drafts['pet-one']?.displayName, '保留我');
  assert.equal(isDraftDirty(controller.getSnapshot(), 'pet-one'), true);
});

test('newer reads supersede old reads; writes supersede pending reads and double submissions are ignored', async () => {
  const first = deferred<PetResult>(), write = deferred<PetResult>(); let reads = 0, saves = 0;
  const controller = new PetWorkspaceController(bridge({ list: () => ++reads === 1 ? first.promise : Promise.resolve(ok()), save: () => { saves++; return write.promise; } }));
  const old = controller.load(); await controller.load(); controller.edit({ displayName: '新版' });
  const save = controller.save(); assert.equal(await controller.save(), false); assert.equal(saves, 1);
  write.resolve(ok({ ...workspace, revision: 2, instances: [{ ...workspace.instances[0]!, displayName: '新版' }] })); await save;
  first.resolve(ok({ ...workspace, revision: 0 })); await old;
  assert.equal(controller.getSnapshot().workspace?.revision, 2);
  assert.equal(controller.getSnapshot().drafts['pet-one']?.displayName, '新版');
});

test('selection keeps per-instance drafts; in-flight successful saves cannot erase newer edits', async () => {
  const second = { ...workspace.instances[0]!, id: 'pet-two', displayName: '小二' };
  const pending = deferred<PetResult>();
  const controller = new PetWorkspaceController(bridge({ list: async () => ok({ ...workspace, instances: [...workspace.instances, second] }), save: () => pending.promise }));
  await controller.load(); controller.edit({ displayName: '请求内' }); const save = controller.save();
  controller.edit({ displayName: '请求后' }); controller.select('pet-two'); controller.edit({ displayName: '另一个草稿' });
  pending.resolve(ok({ ...workspace, revision: 1, instances: [{ ...workspace.instances[0]!, displayName: '请求内' }, second] })); await save;
  assert.equal(controller.getSnapshot().selectedId, 'pet-two');
  assert.equal(controller.getSnapshot().drafts['pet-one']?.displayName, '请求后');
  assert.equal(controller.getSnapshot().drafts['pet-two']?.displayName, '另一个草稿');
});

test('registration is restricted to known catalog, clone selects new definition, deletion requires an explicit target', async () => {
  let adds = 0, deletes = 0;
  const newPet = { ...workspace.instances[0]!, id: 'pet-new', autoStartOnLaunch: false };
  const controller = new PetWorkspaceController(bridge({ add: async () => { adds++; return ok(); }, clone: async () => ok({ ...workspace, revision: 1, instances: [...workspace.instances, newPet] }), delete: async value => { assert.equal(value.id, 'pet-new'); deletes++; return ok({ ...workspace, revision: 2 }); } }));
  await controller.load(); assert.equal(await controller.add({ id: 'fake', version: '1.0.0' }), false); assert.equal(adds, 0);
  await controller.clone(); assert.equal(controller.getSnapshot().selectedId, 'pet-new');
  assert.equal(await controller.confirmDelete(), false); assert.equal(deletes, 0);
  controller.requestDelete(); assert.equal(controller.getSnapshot().deleteId, 'pet-new');
  await controller.confirmDelete(); assert.equal(deletes, 1); assert.equal(controller.getSnapshot().selectedId, 'pet-one');
});

test('theme persistence is service-backed and does not replace an unsaved pet draft', async () => {
  let received: PetInputs['theme'] | undefined;
  const controller = new PetWorkspaceController(bridge({ setTheme: async input => { received = input; return ok({ ...workspace, revision: 1, theme: 'dark' }); } }));
  await controller.load(); controller.edit({ displayName: '未保存' }); await controller.setTheme('dark');
  assert.deepEqual(received, { expectedRevision: 0, theme: 'dark' });
  assert.equal(controller.getSnapshot().workspace?.theme, 'dark');
  assert.equal(controller.getSnapshot().drafts['pet-one']?.displayName, '未保存');
});

const diagnostics = { busy: false, error: '', onRefresh() {}, onProbe() {}, onStartPlayer() {}, onStopPlayer() {} };
test('SSR starts on pets with all nine navigation entries and truthful empty catalog', () => {
  const html = renderToStaticMarkup(createElement(WorkspaceView, diagnostics));
  for (const title of ['我的桌宠', '聊天', '身份', '记忆', '能力与目标', '模型管理', '语音互动', '直播管理', '高级']) assert.ok(html.includes(title), title);
  assert.match(html, /aria-current="page"[^>]*>.*我的桌宠/);
  const planned = renderToStaticMarkup(createElement(WorkspaceView, {...diagnostics,initialPage:'models'}));
  assert.match(planned, /功能尚未迁移/); assert.match(html, /尚未连接桌面宿主/);
  assert.doesNotMatch(html, /启动开发桌宠/);
});

test('on-demand settings preserve editing and the page preserves safe deletion and unavailable registration', async () => {
  const controller = new PetWorkspaceController(bridge()); await controller.load(); controller.edit({ displayName: '草稿' }); controller.requestDelete();
  const html = renderToStaticMarkup(createElement(WorkspaceView, { ...diagnostics, petState: controller.getSnapshot(), petController: controller }));
  const settings = renderToStaticMarkup(createElement(PetSettings, {state:controller.getSnapshot(), controller, onClose(){}}));
  assert.match(settings, /value="草稿"/); assert.match(html, /未保存/);
  assert.match(settings, /min="128"/); assert.match(settings, /max="384"/);
  assert.match(html, /只删除.*配置/); assert.match(html, /不.*删除.*素材/);
  assert.match(html, /role="dialog"/); assert.match(html, /添加桌宠/);
  assert.doesNotMatch(html, /没有可添加的角色，请检查启动命令中的素材目录/);
  assert.match(html, /disabled=""[^>]*>启动/);
});

test('failed writes keep all editable values and never report success', async () => {
  for (const error of ['storage', 'unavailable', 'busy', 'active'] as const) {
    const controller = new PetWorkspaceController(bridge({ save: async () => ({ ok: false, error }) }));
    await controller.load(); controller.edit({ displayName: '要保留', enabled: false, autoStartOnLaunch: true, preferences: { size: 128, scheduledActivity: false, movement: true, hideInFullscreen: false } });
    await controller.save();
    assert.equal(controller.getSnapshot().error, error);
    assert.equal(controller.getSnapshot().drafts['pet-one']?.displayName, '要保留');
    assert.equal(controller.getSnapshot().drafts['pet-one']?.preferences.size, 128);
    assert.equal(controller.getSnapshot().drafts['pet-one']?.enabled, false);
    assert.equal(controller.getSnapshot().notice, '');
  }
});

test('catalog registration sends only service-approved reference and theme failure preserves saved theme', async () => {
  const catalog = [{ id: 'local.development.longmei', version: '0.0.0-dev', name: '龙妹开发配置' }];
  let added: PetInputs['add'] | undefined;
  const controller = new PetWorkspaceController(bridge({ list: async () => ok({ ...workspace, catalog }), add: async input => { added = input; return ok({ ...workspace, catalog, revision: 1 }); }, setTheme: async () => ({ ok: false, error: 'storage' }) }));
  await controller.load(); await controller.add(catalog[0]!);
  assert.deepEqual(added, { expectedRevision: 0, package: { id: 'local.development.longmei', version: '0.0.0-dev' } });
  await controller.setTheme('dark');
  assert.equal(controller.getSnapshot().workspace?.theme, 'system');
  assert.equal(controller.getSnapshot().error, 'storage');
});

test('package picker imports without paths, refreshes catalog, and preserves unsaved drafts', async () => {
 const imported = { ...workspace, catalog: [{ id: 'vendor.pet', version: '1.0.0', name: '导入角色', launchable: false }] };
 let picks = 0;
 const controller = new PetWorkspaceController(bridge({ importPackages: async () => { picks++; return { ok: true, items: [{ name: '角色.petpack', status: 'added', package: { id: 'vendor.pet', version: '1.0.0' } }] }; }, list: async () => ok(imported) }));
 await controller.load(); controller.edit({ displayName: '本地草稿' });
 assert.equal(await controller.importPackages(), true);
 assert.equal(picks, 1);
 assert.deepEqual(controller.getSnapshot().workspace?.catalog, imported.catalog);
 assert.equal(controller.getSnapshot().drafts['pet-one']?.displayName, '本地草稿');
 assert.match(controller.getSnapshot().notice, /成功 1 项，失败 0 项/);
});

test('imported package references are labeled unavailable and cannot trigger player start', () => {
 const imported = { ...workspace, instances: [{ ...workspace.instances[0]!, package: { id: 'vendor.pet', version: '1.0.0' }, phase: 'stopped' as const }], catalog: [{ id: 'vendor.pet', version: '1.0.0', name: '导入角色', launchable: false }] };
 const controller = new PetWorkspaceController(bridge());
 const html = renderToStaticMarkup(createElement(WorkspaceView, { ...diagnostics, petState: { workspace: imported, selectedId: 'pet-one', drafts: { 'pet-one': { displayName: '小一', enabled: true, autoStartOnLaunch: false, preferences: imported.instances[0]!.preferences } }, notice: '', needsRefresh: false }, petController: controller }));
 assert.match(html, /素材已导入，播放器暂不支持启动/);
 assert.match(html, /disabled=""[^>]*>启动/);
});

test('compact cards and on-demand name validation stay semantic', async () => {
  const controller = new PetWorkspaceController(bridge()); await controller.load(); controller.edit({ displayName: 'x'.repeat(81) });
  const html = renderToStaticMarkup(createElement(WorkspaceView, { ...diagnostics, petState: controller.getSnapshot(), petController: controller }));
  assert.match(html, /<article[^>]*aria-label="小一"/); assert.match(html, /未接入播放器/);
  const settings = renderToStaticMarkup(createElement(PetSettings, {state:controller.getSnapshot(), controller, onClose(){}}));
  assert.match(settings, /aria-invalid="true"/); assert.match(settings, /名称需为 1–80 个字符/);
  assert.match(settings, /disabled=""[^>]*>保存设置/);
  assert.doesNotMatch(html, /style=/);
});

test('contract-valid constructor ID receives an own draft and renders without inherited object properties', async () => {
 const value = { ...workspace, instances: [{...workspace.instances[0]!, id:'constructor'}] };
 const controller = new PetWorkspaceController(bridge({list:async()=>ok(value)}));
 await controller.load();
 assert.ok(Object.hasOwn(controller.getSnapshot().drafts,'constructor'));
 assert.equal(Object.values(controller.getSnapshot().drafts)[0]!.displayName,'小一');
 const html=renderToStaticMarkup(createElement(WorkspaceView,{...diagnostics,petState:controller.getSnapshot(),petController:controller}));
 assert.match(html,/设置小一/);
});

test('instance start/stop use only saved ID and revision; phase refresh preserves edited draft', async () => {
 const calls: unknown[]=[];
 let phase: WorkspaceData['instances'][number]['phase']='stopped';
 const view=()=>({...workspace,instances:[{...workspace.instances[0]!,phase}]});
 const controller=new PetWorkspaceController(bridge({list:async()=>ok(view()),start:async input=>{calls.push(input);phase='starting';return ok(view());},stop:async input=>{calls.push(input);phase='stopping';return ok(view());}}));
 await controller.load();controller.edit({displayName:'未保存的名字'});
 assert.equal(await controller.control('start'),true);assert.equal(controller.getSnapshot().workspace!.instances[0]!.phase,'starting');
 assert.equal(await controller.control('stop'),true);
 assert.deepEqual(calls,[{expectedRevision:0,id:'pet-one'},{expectedRevision:0,id:'pet-one'}]);
 phase='stopped';await controller.refreshRuntime();
 assert.equal(controller.getSnapshot().drafts['pet-one']!.displayName,'未保存的名字');assert.equal(isDraftDirty(controller.getSnapshot(),'pet-one'),true);
 assert.equal(controller.getSnapshot().workspace!.instances[0]!.phase,'stopped');
});
test('background phase refresh cannot overwrite a newer control response or clear a revision conflict', async () => {
 const read=deferred<PetResult>();let reads=0;
 const controller=new PetWorkspaceController(bridge({list:()=>++reads===1?Promise.resolve(ok()):read.promise,start:async()=>ok({...workspace,instances:[{...workspace.instances[0]!,phase:'starting'}]})}));
 await controller.load();const refresh=controller.refreshRuntime();await controller.control('start');read.resolve(ok());await refresh;
 assert.equal(controller.getSnapshot().workspace!.instances[0]!.phase,'starting');
 const conflicted=new PetWorkspaceController(bridge({start:async()=>({ok:false,error:'conflict'})}));
 await conflicted.load();await conflicted.control('start');await conflicted.refreshRuntime();assert.equal(conflicted.getSnapshot().needsRefresh,true);
});
test('runtime control shows explicit development start/stop and refuses failed deletion', () => {
 const render=(phase:WorkspaceData['instances'][number]['phase'])=>{
  const controller=new PetWorkspaceController(bridge());
  return renderToStaticMarkup(createElement(WorkspaceView,{petState:{workspace:{...workspace,instances:[{...workspace.instances[0]!,phase}]},selectedId:'pet-one',drafts:{'pet-one':{...workspace.instances[0]!,displayName:'小一'}},notice:'',needsRefresh:false},petController:controller,busy:false,error:'',onRefresh(){},onProbe(){},onStartPlayer(){},onStopPlayer(){}}));
 };
 assert.match(render('stopped'),/>启动</);assert.match(render('starting'),/取消启动/);assert.match(render('running'),/>停止</);assert.match(render('failed'),/确认停止/);
 assert.match(render('failed'),/disabled=""[^>]*>删除实例/);
});
test('instance lifecycle feedback never claims configuration is being saved', () => {
 const html=renderToStaticMarkup(createElement(WorkspaceView,{...diagnostics,petState:{...{workspace,selectedId:'pet-one',drafts:{'pet-one':{...workspace.instances[0]!,displayName:'小一'}},notice:'',needsRefresh:false},operation:'start'}}));
 assert.match(html,/正在请求启动实例/);assert.doesNotMatch(html,/正在保存配置/);
});

test('apply and visibility controls send only the selected ID and preserve unsaved edits on failure', async () => {
 let appliedInput: PetInputs['applyDisplay'] | undefined;
 const controller=new PetWorkspaceController(bridge({
  applyDisplayPreferences:async input=>{appliedInput=input;return {ok:false,error:'unavailable'};},
  setVisible:async input=>{assert.deepEqual(input,{expectedRevision:0,id:'pet-one',visible:false});return ok();},
 }));
 await controller.load();
 controller.edit({displayName:'未保存名称',preferences:{...workspace.instances[0]!.preferences,size:320}});
 assert.equal(await controller.applyDisplayPreferences(),false);
 assert.deepEqual(appliedInput,{expectedRevision:0,id:'pet-one'});
 assert.equal(controller.getSnapshot().drafts['pet-one']!.displayName,'未保存名称');
 assert.equal(isDraftDirty(controller.getSnapshot(),'pet-one'),true);
 assert.equal(await controller.setVisible(false),true);
 assert.equal(controller.getSnapshot().drafts['pet-one']!.preferences.size,320);
});

test('on-demand settings distinguish saved display settings from confirmed runtime settings', () => {
 const applied={size:256,hideInFullscreen:true,visible:true};
 const data={...workspace,instances:[{...workspace.instances[0]!,phase:'running' as const,applied}]};
 const controller=new PetWorkspaceController(bridge());
 const html=renderToStaticMarkup(createElement(PetSettings,{state:{workspace:data,selectedId:'pet-one',drafts:{'pet-one':{...data.instances[0]!,displayName:'小一'}},notice:'',needsRefresh:false},controller,onClose(){}}));
 assert.match(html,/已保存<\/strong>：200 px/);assert.match(html,/运行时已应用<\/strong>：256 px/);
 assert.match(html,/显示偏好待应用/);
 assert.match(html,/<h3[^>]*>活动<\/h3>[\s\S]*自主活动[\s\S]*桌面移动/);
 assert.doesNotMatch(html,/应用启动时自动出现/);
 assert.match(html,/隐藏实例/);
});

test('loading a runtime-saved position revision preserves an unsaved renderer draft', async () => {
 let current = workspace;
 const controller = new PetWorkspaceController(bridge({ list: async () => ({ ok: true, workspace: current }) }));
 await controller.load();
 controller.edit({ displayName: '尚未保存的名称', preferences: { ...workspace.instances[0]!.preferences, size: 300 } });
 current = { ...workspace, revision: 1, instances: [{ ...workspace.instances[0]!, preferences: { ...workspace.instances[0]!.preferences, x: 140, y: 260 } }] };
 assert.equal(await controller.refreshRuntime(), true);
 assert.equal(controller.getSnapshot().workspace!.instances[0]!.preferences.x, 140);
 assert.equal(controller.getSnapshot().drafts['pet-one']!.displayName, '尚未保存的名称');
 assert.equal(controller.getSnapshot().drafts['pet-one']!.preferences.size, 300);
 assert.equal(controller.getSnapshot().drafts['pet-one']!.preferences.x, 140);
 assert.equal(isDraftDirty(controller.getSnapshot(), 'pet-one'), true);
});

test('on-demand settings separate saved position from runtime position and surface persistence failure', () => {
 const item = { ...workspace.instances[0]!, preferences: { ...workspace.instances[0]!.preferences, x: 10, y: 20 },
  phase: 'running' as const, positionFeedback: { x: 30, y: 40, status: 'failed' as const } };
 const html = renderToStaticMarkup(createElement(PetSettings, {
  state: { workspace: { ...workspace, instances: [item] }, selectedId: 'pet-one', drafts: { 'pet-one': { ...item, displayName: '小一' } }, notice: '', needsRefresh: false },
  controller: new PetWorkspaceController(bridge()), onClose(){} }));
 assert.match(html, /已保存位置<\/strong>：10, 20/);
 assert.match(html, /运行时位置<\/strong>：30, 40 · 保存失败；保留上次成功位置/);
});

test('behavior application sends only the saved instance ID and preserves drafts and failure feedback', async () => {
 let sent:unknown;let succeed=false;
 const controller=new PetWorkspaceController(bridge({applyBehaviorPreferences:async input=>{sent=input;return succeed?ok({...workspace,instances:[{...workspace.instances[0]!,behavior:{status:'applied',scheduledActivity:true,movement:false}}]}):{ok:false,error:'apply-failed'};}}));
 await controller.load();controller.edit({displayName:'保留草稿',preferences:{...workspace.instances[0]!.preferences,movement:true}});
 assert.equal(await controller.applyBehaviorPreferences(),false);
 assert.deepEqual(sent,{expectedRevision:0,id:'pet-one'});
 assert.equal(controller.getSnapshot().error,'apply-failed');assert.equal(controller.getSnapshot().notice,'');
 succeed=true;assert.equal(await controller.applyBehaviorPreferences(),true);
 assert.equal(controller.getSnapshot().drafts['pet-one']!.preferences.movement,true);
 assert.equal(controller.getSnapshot().drafts['pet-one']!.displayName,'保留草稿');
 assert.equal(isDraftDirty(controller.getSnapshot(),'pet-one'),true);
 assert.match(controller.getSnapshot().notice,/播放器已确认.*行为偏好/);
});
test('optional settings separate saved behavior and confirmed or failed runtime behavior', () => {
 const render=(behavior:WorkspaceData['instances'][number]['behavior'])=>renderToStaticMarkup(createElement(PetSettings,{state:{workspace:{...workspace,instances:[{...workspace.instances[0]!,phase:'running',behavior}]},selectedId:'pet-one',drafts:{'pet-one':{...workspace.instances[0]!,displayName:'小一'}},notice:'',needsRefresh:false},controller:new PetWorkspaceController(bridge()),onClose(){}}));
 const html=render({status:'applied',scheduledActivity:false,movement:true});
 assert.match(html,/已保存行为/);assert.match(html,/自主活动已开启 · 桌面移动已关闭/);
 assert.match(html,/运行时行为/);assert.match(html,/自主活动已关闭 · 桌面移动已开启/);
 assert.match(html,/应用行为偏好/);assert.match(html,/行为偏好待应用/);
 assert.match(render({status:'failed'}),/应用失败.*尚无可靠确认/);
});

test('linkage pause controls use only the current revision and preserve unsaved drafts', async () => {
 let input:unknown;
 const controller=new PetWorkspaceController(bridge({pause:async value=>{input=value;return ok({...workspace,linkage:'paused'});}}));
 await controller.load();controller.edit({displayName:'保留草稿'});
 assert.equal(await controller.controlLinkage('pause'),true);
 assert.deepEqual(input,{expectedRevision:0});
 assert.equal(controller.getSnapshot().workspace!.revision,0);
 assert.equal(controller.getSnapshot().workspace!.linkage,'paused');
 assert.equal(controller.getSnapshot().drafts['pet-one']!.displayName,'保留草稿');
 assert.equal(isDraftDirty(controller.getSnapshot(),'pet-one'),true);
 assert.match(controller.getSnapshot().notice,/不会自动启动实例/);
});

test('failed pause refreshes volatile linkage state without discarding the editor draft', async () => {
 const paused={...workspace,linkage:'stop-unconfirmed' as const};
 const controller=new PetWorkspaceController(bridge({pause:async()=>({ok:false,error:'apply-failed'}),list:async()=>ok(paused)}));
 await controller.load();controller.edit({displayName:'仍未保存'});
 assert.equal(await controller.controlLinkage('pause'),false);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(controller.getSnapshot().workspace!.linkage,'stop-unconfirmed');
 assert.equal(controller.getSnapshot().drafts['pet-one']!.displayName,'仍未保存');
 assert.equal(isDraftDirty(controller.getSnapshot(),'pet-one'),true);
});

test('linkage page exposes conservative stop-unconfirmed state and manual-only resume', () => {
 const render=(linkage:WorkspaceData['linkage'])=>renderToStaticMarkup(createElement(WorkspaceView,{...diagnostics,petState:{workspace:{...workspace,linkage},selectedId:'pet-one',drafts:{'pet-one':{...workspace.instances[0]!,displayName:'小一'}},notice:'',needsRefresh:false},petController:new PetWorkspaceController(bridge())}));
 assert.match(render('stop-unconfirmed'),/停止未确认/);
 assert.match(render('stop-unconfirmed'),/门禁保持关闭/);
 assert.match(render('paused'),/解除暂停/);
 assert.match(render('paused'),/需逐个手动启动/);
 assert.match(render('active'),/暂停联动/);
});

test('advanced diagnostic player start is visibly disabled behind the linkage gate', () => {
 const html=renderToStaticMarkup(createElement(WorkspaceView,{...diagnostics,initialPage:'advanced',snapshot:{protocolVersion:1,product:'桌边小崽',stage:'foundation',service:{status:'ready'},platform:{os:'macos',session:'native',desktopPet:'not-integrated',limitations:[]},runtime:{kind:'diagnostic',status:'idle',detail:''},player:{kind:'qt-player',status:'stopped',detail:''}},petState:{workspace:{...workspace,linkage:'paused'},drafts:{},notice:'',needsRefresh:false},petController:new PetWorkspaceController(bridge())}));
 assert.match(html,/disabled=""[^>]*>启动开发桌宠/);
});
