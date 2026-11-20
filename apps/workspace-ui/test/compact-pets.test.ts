import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkspaceView } from '../src/App.tsx';
import { PetCover } from '../src/PetCover.tsx';
import { dafeiyu } from '../../../packages/contracts/src/built-in-pets.ts';
import { PetWorkspaceController, type PetWorkspaceState } from '../src/pet-state.ts';
import type { PetsBridge, PetPhase, WorkspaceData } from '../../../packages/contracts/src/pets.ts';
const diagnostics = {busy:false,error:'',onRefresh(){},onProbe(){},onStartPlayer(){},onStopPlayer(){}};
const workspace: WorkspaceData = {revision:4,theme:'system',maximumRunning:3,linkage:'active',catalog:[],instances:[{id:'one',package:{id:'local.development.longmei',version:'0.0.0-dev'},displayName:'小一',enabled:true,autoStartOnLaunch:false,phase:'running',preferences:{size:256,hideInFullscreen:false,scheduledActivity:true,movement:true},applied:{size:256,hideInFullscreen:false,visible:true},behavior:{status:'applied',scheduledActivity:true,movement:true}}]};
const controller = new PetWorkspaceController({list:async()=>({ok:true,workspace})} as PetsBridge);
const state = (phase:PetPhase='running'): PetWorkspaceState => ({workspace:{...workspace,instances:[{...structuredClone(workspace.instances[0]!),phase}]},selectedId:'one',drafts:{one:{...workspace.instances[0]!,displayName:'小一'}},notice:'',needsRefresh:false});
const page = (s=state())=>renderToStaticMarkup(createElement(WorkspaceView,{...diagnostics,petState:s,petController:controller}));
test('one pet has a single role scene without a redundant instance switcher',()=>{
 const html=page();
 assert.match(html, /<section[^>]*class="pet-stage"[^>]*data-pet-art="longmei"/);
 assert.match(html, /当前桌宠/);
 assert.doesNotMatch(html, /class="pet-grid"|aria-label="桌宠实例列表"/);
 assert.doesNotMatch(html,/YOUR LITTLE|COMPANION SETTINGS|配置先安顿好|新架构迁移|隔离开发 ·|M1c|local\.development\.longmei<|你的陪伴清单|每个实例各有偏好/);
 assert.doesNotMatch(html,/实例偏好|已保存位置|运行时位置|<form/);
 assert.doesNotMatch(html.match(/<nav[\s\S]*?<\/nav>/)?.[0]??'',/尚未迁移/);
 assert.match(html,/添加桌宠/); assert.match(html,/设置小一/); assert.match(html,/创建分身/);
});
test('each lifecycle has one appropriate stage action and failed instances cannot be deleted',()=>{
 for(const [phase,label] of [['stopped','启动桌宠'],['starting','取消启动'],['running','停止桌宠'],['stopping','等待退出…'],['failed','确认停止']] as const){
  const html=page(state(phase)); assert.match(html,new RegExp(`>${label}</button>`));
  if(phase==='running')assert.doesNotMatch(html,/>启动<|>启动开发桌宠</);
  if(phase==='failed')assert.match(html,/disabled=""[^>]*>删除实例/);
 }
});
test('instance selection renders one scene, keeps non-selected failures visible, and does not call the bridge', async () => {
 const first = { ...workspace.instances[0]!, phase: 'failed' as const };
 const second = { ...first, id: 'two', phase: 'stopped' as const, displayName: '小二', package: { id: 'example.other', version: '1.0.0' } };
 let reads = 0;
 const controller = new PetWorkspaceController({ list: async () => {
  reads++;
  return { ok: true, workspace: { ...workspace, instances: [first, second] } };
 } } as PetsBridge);
 await controller.load();
 controller.edit({displayName: '尚未保存'});
 controller.select('two');
 const html = renderToStaticMarkup(createElement(WorkspaceView, { ...diagnostics, petState: controller.getSnapshot(), petController: controller }));
 const stage = html.match(/<section[^>]*class="pet-stage"[\s\S]*?<\/section>/)?.[0] ?? '';
 const list = html.match(/<ul aria-label="桌宠实例列表">[\s\S]*?<\/ul>/)?.[0] ?? '';
 assert.equal(reads, 1);
 assert.equal(controller.getSnapshot().drafts.one!.displayName, '尚未保存');
 assert.match(stage, /data-pet-art="default"/);
 assert.match(stage, />小二<\/h2>/);
 assert.match(stage, /id="pet-settings-two"/);
 assert.match(stage, /src="\.\/assets\/app-icon\.svg"/);
 assert.doesNotMatch(stage, /pet-app:|设置小一/);
 assert.match(list, /aria-pressed="false"[\s\S]*?>小一</);
 assert.match(list, /aria-pressed="true"[\s\S]*?>小二</);
 assert.match(list, /未保存/);
 assert.match(list, /运行失败，请确认停止后重试/);
 assert.doesNotMatch(list, /设置小一|创建分身|>启动<\/button>/);
});

test('missing workspace and empty instance list do not invent a current character', () => {
 const missing = renderToStaticMarkup(createElement(WorkspaceView, diagnostics));
 assert.match(missing, /尚未连接桌面宿主/);
 assert.doesNotMatch(missing, /class="pet-stage"|当前桌宠/);
 const s = state(); s.workspace!.instances = []; s.selectedId = undefined;
 const empty = page(s);
 assert.match(empty, /还没有桌宠/);
 assert.doesNotMatch(empty, /class="pet-stage"|当前桌宠|pet-app:\/\/workspace\/covers/);
});

test('runtime failures and stale feedback remain visible outside the optional settings',()=>{
 const s=state();s.runtimeStale=true;s.workspace!.instances[0]!.positionFeedback={x:30,y:40,status:'failed'};
 s.workspace!.instances[0]!.behavior={status:'failed'};
 const html=page(s);assert.match(html,/位置保存失败/);assert.match(html,/行为应用失败/);assert.match(html,/运行状态.*刷新/);
});
test('on-demand settings preserve form bounds, saved/runtime distinction and collapsed diagnostic details',async()=>{
 const {PetSettings}=await import('../src/PetSettings.tsx');
 const s=state();s.workspace!.instances[0]!.applied!.size=200;
 const html=renderToStaticMarkup(createElement(PetSettings,{state:s,controller,onClose(){}}));
 assert.match(html,/<dialog\b/);assert.match(html,/min="128"/);assert.match(html,/max="384"/);
 assert.match(html,/显示偏好待应用/);assert.match(html,/<details[^>]*>[\s\S]*运行详情/);
 assert.match(html,/已保存.*256 px/);assert.match(html,/运行时已应用.*200 px/);
 assert.doesNotMatch(html,/应用启动时自动出现|COMPANION SETTINGS/);
});
test('settings do not imply failed or missing behavior confirmation is applied',async()=>{
 const {PetSettings}=await import('../src/PetSettings.tsx');
 for(const behavior of [undefined,{status:'failed' as const}]){
  const s=state();s.workspace!.instances[0]!.behavior=behavior;
  const html=renderToStaticMarkup(createElement(PetSettings,{state:s,controller,onClose(){}}));
  assert.match(html,behavior?/行为应用失败/:/行为尚未确认/);
  assert.doesNotMatch(html,/>运行偏好已应用</);
 }
});
test('the selected stage exposes controls and keeps secondary actions in a collapsed disclosure',()=>{
 const html=page();
 const actions=html.match(/<div class="pet-stage-actions">([\s\S]*?)<\/section>/)?.[1]??'';
 assert.match(actions,/>停止桌宠<\/button>/);
 assert.match(actions,/id="pet-settings-one"[^>]*>设置<\/button>/);
 assert.match(actions,/aria-expanded="false"[^>]*>更多<\/button>/);
 assert.match(actions,/class="pet-more-actions"[^>]*hidden=""/);
 assert.doesNotMatch(html,/class="pet-card-tools"/);
});
test('settings modal has an accessible title and separates scrolling fields from header and save footer',async()=>{
 const {PetSettings}=await import('../src/PetSettings.tsx');
 const s=state(); s.drafts.one!.displayName='未保存的名字'; s.error='storage';
 const html=renderToStaticMarkup(createElement(PetSettings,{state:s,controller,onClose(){}}));
 const title = html.match(/<dialog\b[^>]*aria-labelledby="([^"]+)"/)?.[1];
 assert.ok(title, 'settings use a native modal with an accessible title');
 assert.ok(html.includes(`<h2 id="${title}">桌宠设置</h2>`));
 assert.match(html,/<header class="settings-heading">[\s\S]*桌宠设置[\s\S]*小一 · 运行中[\s\S]*<\/header>/);
 assert.match(html,/<form[^>]*class="settings-form"[^>]*><div class="settings-body">/);
 assert.match(html,/<\/div><footer class="save-bar">[\s\S]*保存设置[\s\S]*<\/footer><\/form>/);
 assert.match(html,/value="未保存的名字"/); assert.match(html,/role="alert"/);
 assert.doesNotMatch(html,/role="tablist"/);
 assert.match(html,/>基本<\/h3>[\s\S]*>外观<\/h3>[\s\S]*>行为<\/h3>/);
});
test('video settings offer visibility and both behavior controls', async () => {
 const { PetSettings } = await import('../src/PetSettings.tsx');
 const s = state();
 s.workspace!.playerMode = 'video';
 delete s.workspace!.instances[0]!.applied;
 delete s.workspace!.instances[0]!.behavior;
 const html = renderToStaticMarkup(createElement(PetSettings, { state: s, controller, onClose() {} }));
 assert.match(html, /手动显示仍遵守全屏隐藏策略/);
 assert.match(html, />应用显示偏好</);
 assert.match(html, />应用行为偏好</);
 assert.match(html, />隐藏实例</);
 assert.doesNotMatch(html, /自主活动暂不支持|应用拖动位移/);
 assert.doesNotMatch(html, /id="[^"]*-scheduled"[^>]*disabled/);
});

test('the pet cover and member avatar disable native image dragging, including the fallback', () => {
 for (const avatar of [false, true]) {
  const html = renderToStaticMarkup(createElement(PetCover, { reference: dafeiyu, avatar }));
  const images = html.match(/<img\b[^>]*>/g) ?? [];
  assert.equal(images.length, 2, 'both the pet image and its fallback are rendered');
  for (const image of images) assert.match(image, /\bdraggable="false"/);
 }
});

test('the nook presents the staged companion separately from owned instances', () => {
 const s = state();
 s.workspace!.catalog = [{ id: 'local.community.dafeiyu', version: '0.0.0-dev', name: '大肥鱼', launchable: true }];
 const html = page(s);
 assert.match(html, /桌边小窝/);
 assert.match(html, /今天也一起待在桌边。/);
 assert.match(html, /class="pet-member"[^>]*data-pet-art="dafeiyu"[\s\S]*?大肥鱼[\s\S]*?可添加/);
 assert.match(html, /pet-app:\/\/workspace\/covers\/local.community.dafeiyu\/0.0.0-dev\.png/);
 assert.equal(s.workspace!.instances.length, 1);
});
