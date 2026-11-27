import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';import {test} from 'node:test';import {createElement} from 'react';import {renderWorkspace} from './render-workspace.ts';import {LivePage} from '../src/pages/LivePage.tsx';

test('live page exposes both fixed presenters and scoped binding entry points without exposing the binding form',async()=>{
 const html=await renderWorkspace(createElement(LivePage,{instances:[
  {id:'pet-dragon',displayName:'龙妹实例',package:{id:'local.development.longmei',version:'0.0.0-dev'}},
  {id:'pet-whale',displayName:'鲸鱼妹实例',package:{id:'local.community.dafeiyu',version:'0.0.0-dev'}},
  {id:'pet-other',displayName:'其他实例',package:{id:'local.other',version:'1.0.0'}},
 ]}));
 assert.match(html,/龙妹/);assert.match(html,/鲸鱼妹/);assert.match(html,/绑定实例/);assert.match(html,/尚未绑定/);assert.doesNotMatch(html,/<select/);
 assert.doesNotMatch(html,/暂不支持直播/);assert.doesNotMatch(html,/pet-other/);
});

// SSR only renders the initial role; it does not reconcile these siblings after a bind or switch.
test('live voice and sharing panels have distinct role-scoped reconciliation keys', async () => {
  const source = await readFile(new URL('../src/pages/LivePage.tsx', import.meta.url), 'utf8');
  const voiceKey = source.match(/<LiveVoiceProfile\s+key=\{(`[^`]+`)\}/)?.[1];
  const sharingKey = source.match(/<LiveSharing\s+key=\{(`[^`]+`)\}/)?.[1];
  assert.ok(voiceKey && sharingKey);
  assert.notEqual(voiceKey, sharingKey.replace('bindings.bindings[role.id]', 'petID'), 'colliding sibling keys leave duplicate panels after a bind or switch');
});
