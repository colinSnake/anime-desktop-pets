import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkspaceView } from '../src/App.tsx';
import { PetWorkspaceController, type PetWorkspaceState } from '../src/pet-state.ts';
import type { PetsBridge, PetPhase, WorkspaceData } from '../../../packages/contracts/src/pets.ts';
const diagnostics = {busy:false,error:'',onRefresh(){},onProbe(){},onStartPlayer(){},onStopPlayer(){}};
const workspace: WorkspaceData = {revision:4,theme:'system',maximumRunning:3,linkage:'active',catalog:[],instances:[{id:'one',package:{id:'local.development.longmei',version:'0.0.0-dev'},displayName:'小一',enabled:true,autoStartOnLaunch:false,phase:'running',preferences:{size:256,hideInFullscreen:false,scheduledActivity:true,movement:true},applied:{size:256,hideInFullscreen:false,visible:true},behavior:{status:'applied',scheduledActivity:true,movement:true}}]};
const controller = new PetWorkspaceController({list:async()=>({ok:true,workspace})} as PetsBridge);
const state = (phase:PetPhase='running'): PetWorkspaceState => ({workspace:{...workspace,instances:[{...structuredClone(workspace.instances[0]!),phase}]},selectedId:'one',drafts:{one:{...workspace.instances[0]!,displayName:'小一'}},notice:'',needsRefresh:false});
const page = (s=state())=>renderToStaticMarkup(createElement(WorkspaceView,{...diagnostics,petState:s,petController:controller}));
test('daily pet page is a compact card grid without technical, promotional or English subheadings',()=>{
 const html=page();
 assert.match(html,/class="pet-grid"/); assert.match(html,/<article[^>]*class="pet-card/);
 assert.doesNotMatch(html,/YOUR LITTLE|COMPANION SETTINGS|配置先安顿好|新架构迁移|隔离开发 ·|M1c|local\.development\.longmei<|你的陪伴清单|每个实例各有偏好/);
 assert.doesNotMatch(html,/实例偏好|已保存位置|运行时位置|<form/);
 assert.doesNotMatch(html.match(/<nav[\s\S]*?<\/nav>/)?.[0]??'',/尚未迁移/);
 assert.match(html,/添加桌宠/); assert.match(html,/设置小一/); assert.match(html,/创建分身/);
});
test('each lifecycle has one appropriate primary card action and failed instances cannot be deleted',()=>{
 for(const [phase,label] of [['stopped','启动'],['starting','取消启动'],['running','停止'],['stopping','等待退出…'],['failed','确认停止']] as const){
  const html=page(state(phase)); assert.match(html,new RegExp(`>${label}</button>`));
  if(phase==='running')assert.doesNotMatch(html,/>启动<|>启动开发桌宠</);
  if(phase==='failed')assert.match(html,/disabled=""[^>]*>删除实例/);
 }
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
 assert.match(html,/role="dialog"/);assert.match(html,/min="128"/);assert.match(html,/max="384"/);
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
test('card presents three peer controls and keeps secondary actions in a collapsed disclosure',()=>{
 const html=page();
 const actions=html.match(/<div class="pet-card-actions">([\s\S]*?)<\/article>/)?.[1]??'';
 assert.match(actions,/>停止<\/button>/);
 assert.match(actions,/>设置<\/button>/);
 assert.match(actions,/aria-expanded="false"[^>]*>更多<\/button>/);
 assert.match(actions,/class="pet-more-actions"[^>]*hidden=""/);
 assert.doesNotMatch(html,/class="pet-card-tools"/);
});
test('settings sheet keeps scrolling content separate from persistent header and save footer',async()=>{
 const {PetSettings}=await import('../src/PetSettings.tsx');
 const s=state(); s.drafts.one!.displayName='未保存的名字'; s.error='storage';
 const html=renderToStaticMarkup(createElement(PetSettings,{state:s,controller,onClose(){}}));
 assert.match(html,/class="modal-backdrop settings-backdrop"/);
 assert.match(html,/<header class="settings-heading">[\s\S]*小一设置[\s\S]*<\/header>/);
 assert.match(html,/<form[^>]*class="settings-form"[^>]*><div class="settings-body">/);
 assert.match(html,/<\/div><footer class="save-bar">[\s\S]*保存设置[\s\S]*<\/footer><\/form>/);
 assert.match(html,/value="未保存的名字"/); assert.match(html,/role="alert"/);
 assert.doesNotMatch(html,/role="tablist"/);
 assert.match(html,/<summary>启动选项<\/summary>/);
});
