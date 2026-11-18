import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatPage, replyTimestamp } from '../src/ChatPage.tsx';
import { ChatWorkspaceController, type ChatRequest } from '../src/chat-session.ts';
import { WorkspaceView } from '../src/App.tsx';
const diagnostics={busy:false,error:'',onRefresh(){},onProbe(){},onStartPlayer(){},onStopPlayer(){}};
const create=(reply?: (request:ChatRequest, signal:AbortSignal)=>Promise<string>)=>{
 const c=new ChatWorkspaceController(reply?{models:[{id:'synthetic',name:'合成模型'}],reply}:undefined);
 c.syncCharacters([{id:'pet-one',name:'龙妹'}]);return c;
};
const render=(c:ChatWorkspaceController)=>renderToStaticMarkup(createElement(ChatPage,{state:c.getSnapshot(),controller:c,onOpenModels(){}}));
test('chat opens a macOS welcome and an editable native composer but no fake send/model controls',()=>{
 const c=create();c.edit('未保存的草稿');const html=render(c);
 assert.match(html,/今天想和龙妹聊点什么/);assert.match(html,/chat-welcome-mark/);
 assert.match(html,/<textarea[^>]*aria-label="聊天消息"/);assert.match(html,/未保存的草稿/);
 assert.doesNotMatch(html,/<textarea[^>]*(?:readonly|disabled)/);
 assert.match(html,/<button[^>]*disabled=""[^>]*aria-label="发送消息"/);
 assert.match(html,/模型服务尚未接入/);assert.match(html,/前往模型管理/);
 assert.doesNotMatch(html,/type="file"|contenteditable|假回复|dangerouslySetInnerHTML/);
});
test('workspace routes chat to the real page rather than the planned-module card',()=>{
 const c=create(); const html=renderToStaticMarkup(createElement(WorkspaceView,{...diagnostics,initialPage:'chat',chatState:c.getSnapshot(),chatController:c}));
 assert.match(html,/aria-label="聊天消息"/);assert.doesNotMatch(html,/功能尚未迁移|聊天、任务与模型调用尚未接入本工作区/);
});
test('turns render as escaped text with fixed assistant-only timestamps and stable scroll anchors',async()=>{
 const c=create(async()=>'<script>不是HTML</script>');c.edit('提问');await c.send();const html=render(c);
 assert.match(html,/&lt;script&gt;不是HTML&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>/);
 assert.equal((html.match(/<time /g)??[]).length,1);
 assert.match(html,/<time[^>]*>\d{2}:\d{2}:\d{2}<\/time>/);
 assert.match(html,new RegExp(`data-turn-id="${c.getSnapshot().session.turns.at(-1)!.id}"`));
 assert.equal(replyTimestamp(0,new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'})),'00:00:00');
});
test('waiting offers stop instead of send and keeps next-question editing available',()=>{
 const c=create(async()=>new Promise(()=>{}));c.edit('问题');void c.send(); const html=render(c);
 assert.match(html,/aria-label="停止等待回复"/);assert.doesNotMatch(html,/aria-label="发送消息"/);
 assert.doesNotMatch(html,/<textarea[^>]*(?:readonly|disabled)/);assert.match(html,/等待回复/);c.cancel();
});
test('clear confirmation preserves the conversation until confirmed and errors retain restore/retry actions',async()=>{
 const c=create(async()=>{throw Error('/private');});c.edit('问题');await c.send();
 assert.match(render(c),/重试/);assert.match(render(c),/恢复输入/);assert.doesNotMatch(render(c),/private/);
 c.requestClear();assert.match(render(c),/<dialog[^>]*role="alertdialog"/);assert.match(render(c),/只清空本轮消息/);
 assert.equal(c.getSnapshot().session.turns.length,1);c.cancelClear();assert.doesNotMatch(render(c),/role="alertdialog"/);
});
test('input counter exposes rather than silently truncates overlong drafts',()=>{
 const c=create();c.edit('字'.repeat(1201)); const html=render(c);
 assert.match(html,/1201\/1200/);assert.match(html,/aria-invalid="true"/);
 assert.equal(c.getSnapshot().session.draft.length,1201);
});

test('chat labels local queries and answers while keeping model selection and ordinary send disabled', async () => {
 const c = new ChatWorkspaceController(undefined, { localChatContext: async ({ petID }) => ({ ok: true, petID, text: '合成身份' }) });
 c.syncCharacters([{ id: 'pet-one', name: '合成角色' }]);
 c.edit('一般问题');
 assert.match(render(c), /<button[^>]*disabled=""[^>]*aria-label="发送消息"/);
 assert.match(render(c), /查看目标进度/);
 c.edit('你是谁？');
 assert.match(render(c), /<button(?:(?!disabled)[^>])*aria-label="查询本机资料"/);
 assert.match(render(c), /<button[^>]*chat-model-toggle[^>]*disabled=""/);
 await c.send();
 assert.match(render(c), /本机资料回复/);
 assert.match(render(c), /合成身份/);
});

test('online composer identifies the selected connection and discloses that sending may incur charges', async () => {
 const c = new ChatWorkspaceController(undefined, undefined, { list: async () => ({ ok: true, models: [{
  route: { connectionID: 'first', modelEntryID: 'one', fingerprint: 'a'.repeat(64) }, connectionName: '合成连接', modelName: '合成模型', ready: true, isDefault: true,
 }] }), send: async () => ({ ok: false, error: 'unavailable' }), cancel: async () => {} });
 c.syncCharacters([{ id: 'pet-one', name: '龙妹' }]); await c.refreshModels(); c.edit('合成问题');
 const html = render(c);
 assert.match(html, /合成模型 · 合成连接/); assert.match(html, /可能产生费用/);
 assert.doesNotMatch(html, /disabled=""[^>]*aria-label="发送消息"/);
 c.edit('👨‍👩‍👧‍👦'.repeat(800));
 assert.match(render(c), /超出字节上限/);
 assert.match(render(c), /disabled=""[^>]*aria-label="发送消息"/);
});
