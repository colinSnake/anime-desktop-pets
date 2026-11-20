import { renderWorkspace } from './render-workspace.ts';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThemeToggle, nextTheme } from '../src/ThemeToggle.tsx';
import { WorkspaceView } from '../src/App.tsx';
import { PetWorkspaceController, emptyPetState, type PetWorkspaceState } from '../src/pet-state.ts';
import type { PetsBridge, PetInputs, PetResult, Theme, WorkspaceData } from '../../../packages/contracts/src/pets.ts';

const workspace: WorkspaceData = { revision: 4, theme: 'system', maximumRunning: 3, linkage: 'active', catalog: [],
  instances: [{id:'pet-one',package:{id:'dev.longmei',version:'1.0.0'},displayName:'小一',enabled:true,autoStartOnLaunch:false,
    preferences:{size:256,hideInFullscreen:false,scheduledActivity:false,movement:false},phase:'stopped'}] };
const diagnostics = {busy:false,error:'',onRefresh(){},onProbe(){},onStartPlayer(){},onStopPlayer(){}};
const bridge = (setTheme: PetsBridge['setTheme']) => ({list: async () => ({ok:true,workspace}),setTheme}) as PetsBridge;

test('theme cycles in the native macOS order: system, dark, light, system', () => {
  assert.equal(nextTheme('system'),'dark'); assert.equal(nextTheme('dark'),'light'); assert.equal(nextTheme('light'),'system');
});

test('theme icon button exposes the saved mode through accessible name and tooltip, not a dropdown', () => {
  for (const [theme,title] of [['system','跟随系统'],['dark','深色主题'],['light','浅色主题']] as const) {
    const html=renderToStaticMarkup(createElement(ThemeToggle,{theme,disabled:false,onChange(){}}));
    assert.ok(html.includes(`aria-label="外观：${title}"`));
    assert.ok(html.includes(`title="外观：${title}（点击切换）"`));
    assert.match(html,/<svg[^>]*aria-hidden="true"/);assert.doesNotMatch(html,/<select|<option/);
  }
});

test('follow system uses a monitor glyph distinct from the moon and sun', () => {
  const glyph = (theme: Theme) => renderToStaticMarkup(createElement(ThemeToggle, { theme, disabled: false, onChange() {} }));
  assert.match(glyph('system'), /<rect[^>]*>[\s\S]*?<path/);
  assert.doesNotMatch(glyph('dark'), /<rect\b/);
  assert.doesNotMatch(glyph('light'), /<rect\b/);
});

test('theme glyphs share a 20 px box without resizing the button', async () => {
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.theme-toggle > svg\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px;/);
  assert.match(css, /\.theme-toggle\s*\{[^}]*width:\s*36px;[^}]*height:\s*36px;/);
});

test('one global theme toggle lives in the top-right action group on pets, advanced and planned pages, never in sidebar', async () => {
  const controller=new PetWorkspaceController(bridge(async()=>({ok:true,workspace})));
  await controller.load();
  for (const initialPage of ['pets','advanced','chat','speech','live'] as const) {
    const html=await renderWorkspace(createElement(WorkspaceView,{...diagnostics,initialPage,petState:controller.getSnapshot(),petController:controller}));
    const sidebar=html.match(/<aside[\s\S]*?<\/aside>/)?.[0];assert.ok(sidebar);assert.doesNotMatch(sidebar,/theme-toggle|workspace-theme|界面主题/);
    assert.match(html,/class="workspace-topline-actions"[\s\S]*?class="theme-toggle"/);
    assert.equal((html.match(/class="theme-toggle"/g)??[]).length,1);
  }
});

test('the common workspace header uses the product icon without repeating its accessible name', async () => {
  for (const initialPage of ['pets', 'chat', 'advanced'] as const) {
    const html = await renderWorkspace(createElement(WorkspaceView, {...diagnostics, initialPage}));
    const brand = html.match(/<button class="brand"[^>]*>.*?<\/button>/)?.[0];
    assert.ok(brand);
    assert.match(brand, /<img[^>]*src="\.\/assets\/app-icon\.svg"[^>]*alt=""/);
    assert.match(brand, /<span>桌边小崽<\/span>/);
    assert.doesNotMatch(brand, />崽</);
  }
});

test('global theme button disables without a connection, on refresh conflicts and while any write is pending', async () => {
  const controller=new PetWorkspaceController(bridge(async()=>({ok:true,workspace})));
  await controller.load();
  const base=controller.getSnapshot();
  const cases: Array<{state:PetWorkspaceState;connected:boolean}>=[{state:emptyPetState,connected:false},
    {state:base,connected:false},{state:{...base,needsRefresh:true},connected:true},
    {state:{...base,operation:'theme'},connected:true},{state:{...base,operation:'save'},connected:true}];
  for (const {state,connected} of cases) {
    const html=renderToStaticMarkup(createElement(WorkspaceView,{...diagnostics,petState:state,petController:connected?controller:undefined}));
    assert.match(html,/<button[^>]*class="theme-toggle"[^>]*disabled=""/);
  }
});

test('failed theme save keeps the confirmed theme, revision and unsaved pet draft without a success notice', async () => {
  const controller=new PetWorkspaceController(bridge(async()=>({ok:false,error:'storage'})));
  await controller.load();controller.edit({displayName:'不要丢失'});
  assert.equal(await controller.setTheme('dark'),false);
  const state=controller.getSnapshot();
  assert.equal(state.workspace?.theme,'system');assert.equal(state.workspace?.revision,4);
  assert.equal(state.drafts['pet-one']?.displayName,'不要丢失');assert.equal(state.notice,'');assert.equal(state.error,'storage');
});

test('pending theme saves do not optimistically cycle or issue duplicate writes, and success keeps drafts', async () => {
  let finish!: (value:PetResult)=>void;
  const pending=new Promise<PetResult>(resolve=>{finish=resolve;});
  const inputs: Array<PetInputs['theme']>=[];
  const controller=new PetWorkspaceController(bridge(async input=>{inputs.push(input);return pending;}));
  await controller.load();controller.edit({displayName:'草稿'});
  const first=controller.setTheme(nextTheme('system'));
  assert.equal(controller.getSnapshot().workspace?.theme,'system');
  assert.equal(await controller.setTheme('light'),false);assert.equal(inputs.length,1);
  finish({ok:true,workspace:{...workspace,theme:'dark' as Theme,revision:5}});
  assert.equal(await first,true);assert.deepEqual(inputs,[{expectedRevision:4,theme:'dark'}]);
  assert.equal(controller.getSnapshot().workspace?.theme,'dark');assert.equal(controller.getSnapshot().drafts['pet-one']?.displayName,'草稿');
});
