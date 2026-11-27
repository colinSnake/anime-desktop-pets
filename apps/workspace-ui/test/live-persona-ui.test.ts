import assert from 'node:assert/strict';import {test} from 'node:test';import {createElement} from 'react';import {renderWorkspace} from './render-workspace.ts';import {LivePage} from '../src/pages/LivePage.tsx';

test('live page exposes both fixed presenters and only role-matching registered binding choices',async()=>{
 const html=await renderWorkspace(createElement(LivePage,{instances:[
  {id:'pet-dragon',displayName:'龙妹实例',package:{id:'local.development.longmei',version:'0.0.0-dev'}},
  {id:'pet-whale',displayName:'鲸鱼妹实例',package:{id:'local.community.dafeiyu',version:'0.0.0-dev'}},
  {id:'pet-other',displayName:'其他实例',package:{id:'local.other',version:'1.0.0'}},
 ]}));
 assert.match(html,/龙妹/);assert.match(html,/鲸鱼妹/);assert.match(html,/绑定的桌宠实例/);assert.match(html,/未绑定/);
 assert.doesNotMatch(html,/暂不支持直播/);assert.doesNotMatch(html,/pet-other/);
});
