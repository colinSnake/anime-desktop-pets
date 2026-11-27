import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderWorkspace } from './render-workspace.ts';
import { LivePage } from '../src/pages/LivePage.tsx';
import { LiveSettingsDrawer } from '../src/pages/LiveSettingsDrawer.tsx';
import { LiveVoiceProfile } from '../src/pages/LiveVoiceProfile.tsx';
import { LiveSharing } from '../src/pages/LiveSharing.tsx';

const source = () => readFile(new URL('../src/pages/LivePage.tsx', import.meta.url), 'utf8');
test('live workbench groups the stage and scenes separately from presenter and interaction controls', async () => {
  const html = await renderWorkspace(createElement(LivePage));
  assert.match(html, /直播工作台/);
  assert.match(html, /live-workbench-main/);
  assert.match(html, /live-workbench-controls/);
  assert.match(html, /舞台预览/);
  assert.match(html, /布景示意/);
  assert.match(html, /主播互动/);
  assert.match(html, /选择布景/);
});
test('an unbound presenter has an explicit binding action rather than an expanded form', async () => {
  const html = await renderWorkspace(createElement(LivePage));
  assert.match(html, /尚未绑定/);
  assert.match(html, /绑定桌宠/);
  assert.doesNotMatch(html, /<select/);
  assert.match(html, /停台时可切换/);
});
test('live workbench does not reintroduce rejected helper copy or synthetic production state', async () => {
  const html = await renderWorkspace(createElement(LivePage));
  for (const copy of ['一次一条，看看她怎么回应', '回复会用于节目字幕与本机合成', '不采集麦克风，不混入桌面声音', '学习由你发起，候选仍需人工审核', '查看状态', '示例数据']) assert.ok(!html.includes(copy), copy);
  const page = await source();
  assert.match(page, /bridge!\.preview\(role\.id\)/);
  assert.match(page, /setPreview\(\{ id: scene\.id/);
  assert.doesNotMatch(page, /iframe/);
});

test('the settings drawer labels its modal and keeps the close button disabled while committing', async () => {
  const html = await renderWorkspace(createElement(LiveSettingsDrawer, {title:'直播设置',busy:true,onClose(){},children:'测试内容'}));
  assert.match(html, /<dialog[^>]+aria-modal="true"[^>]+aria-busy="true"/);
  assert.match(html, /aria-label="关闭设置"[^>]+disabled/);
  assert.match(html, /aria-labelledby=/);
});
test('unread configuration summaries do not invent ready voices or empty authorizations', async () => {
  const voice = await renderWorkspace(createElement(LiveVoiceProfile, {locked:false,onBusy(){}}));
  const sharing = await renderWorkspace(createElement(LiveSharing, {role:'longmei',petID:'pet-one',locked:false}));
  assert.match(voice, /绑定后配置/);
  assert.doesNotMatch(voice, /<textarea|已配置/);
  assert.match(sharing, /不可用/);
  assert.doesNotMatch(sharing, /未授权/);
});

test('configuration summaries distinguish missing bindings and unavailable bridges from unread settings', async () => {
  const target = { role: 'longmei' as const, petID: 'pet-one', bindingRevision: 0 };
  const voice = await renderWorkspace(createElement(LiveVoiceProfile, {target, locked:false,onBusy(){}}));
  assert.match(voice, /当前环境未接入/);
  assert.match(voice, /不可用/);
  assert.doesNotMatch(voice, /点击查看本机音色/);
  const unbound = await renderWorkspace(createElement(LiveSharing, {role:'longmei',petID:null,locked:false}));
  assert.match(unbound, /待绑定/);
  assert.doesNotMatch(unbound, /未读取/);
  const unavailable = await renderWorkspace(createElement(LiveSharing, {role:'longmei',petID:'pet-one',locked:false}));
  assert.match(unavailable, /当前环境未接入/);
  assert.match(unavailable, /不可用/);
});


test('binding read failures and conflicts provide a guarded in-page retry rather than a dead end', async () => {
  const page = await source();
  assert.match(page, /重新读取绑定/);
  assert.match(page, /\[bridge,\s*bindingReadRequest\]/);
  assert.match(page, /!bindingNeedsRead/);
  assert.match(page, /setBindingNeedsRead\(true\)/);
  assert.match(page, /setBindingNeedsRead\(false\)/);
  assert.match(page, /bindingNeedsRead \|\| !petID/);
});
