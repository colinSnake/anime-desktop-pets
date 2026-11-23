import { dafeiyu, longmei } from '../../../packages/contracts/src/built-in-pets.ts';
import { renderWorkspace } from './render-workspace.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatPage } from '../src/ChatPage.tsx';
import { replyTimestamp } from '../src/ChatMessage.tsx';
import { ChatWorkspaceController, type ChatRequest } from '../src/chat-session.ts';
import { WorkspaceView } from '../src/App.tsx';
const diagnostics={busy:false,error:'',onRefresh(){},onProbe(){},onStartPlayer(){},onStopPlayer(){}};
const create=(reply?: (request:ChatRequest, signal:AbortSignal)=>Promise<string>)=>{
 const c=new ChatWorkspaceController(reply?{models:[{id:'synthetic',name:'合成模型'}],reply}:undefined);
 c.syncCharacters([{id:'pet-one',name:'龙妹'}]);return c;
};
const render=(c:ChatWorkspaceController)=>renderToStaticMarkup(createElement(ChatPage,{state:c.getSnapshot(),controller:c}));
test('chat opens a character welcome and a plain-text editor surface but no fake send/model controls',()=>{
 const c=create();c.edit('未保存的草稿');const html=render(c);
 assert.match(html,/今天想和龙妹聊点什么/);assert.match(html,/class="chat-portrait"/);
 assert.match(html,/<div[^>]*role="textbox"[^>]*aria-label="聊天消息"/);
 assert.doesNotMatch(html, /<textarea|contenteditable="false"/);
 assert.doesNotMatch(html,/<[^>]*role="textbox"[^>]*aria-readonly="true"/);
 assert.match(html,/<button[^>]*disabled=""[^>]*aria-label="发送消息"/);
 assert.match(html, />模型服务尚未接入，草稿会保留。<\/span>/);
 assert.doesNotMatch(html,/type="file"|假回复|dangerouslySetInnerHTML/);
});
test('workspace routes chat to the real page rather than the planned-module card',async()=>{
 const c=create(); const html=await renderWorkspace(createElement(WorkspaceView,{...diagnostics,initialPage:'chat',chatState:c.getSnapshot(),chatController:c}));
 assert.match(html,/aria-label="聊天消息"/);assert.doesNotMatch(html,/功能尚未迁移|聊天、任务与模型调用尚未接入本工作区/);
});
test('turns render as escaped text with fixed assistant-only timestamps and stable scroll anchors',async()=>{
 const c=create(async()=>'<script>不是HTML</script>');c.edit('提问');await c.send();const html=render(c);
 assert.match(html,/&lt;script&gt;不是HTML&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>/);
 assert.equal((html.match(/<time /g)??[]).length,1);
 assert.match(html,/<time[^>]*aria-label="回复时间 \d{2}:\d{2}:\d{2}"[^>]*>\d{2}:\d{2}<\/time>/);
 assert.match(html,new RegExp(`data-turn-id="${c.getSnapshot().session.turns.at(-1)!.id}"`));
 assert.equal(replyTimestamp(0,new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'})),'00:00:00');
});
test('waiting offers stop instead of send and keeps next-question editing available',()=>{
 const c=create(async()=>new Promise(()=>{}));c.edit('问题');void c.send(); const html=render(c);
 assert.match(html,/aria-label="停止等待回复"/);assert.doesNotMatch(html,/aria-label="发送消息"/);
 assert.doesNotMatch(html,/<[^>]*role="textbox"[^>]*aria-readonly="true"/);assert.match(html,/等待回复/);c.cancel();
});
test('clear confirmation preserves the conversation until confirmed and errors retain restore/retry actions',async()=>{
 const c=create(async()=>{throw Error('/private');});c.edit('问题');await c.send();
 assert.match(render(c),/重试/);assert.match(render(c),/恢复输入/);assert.doesNotMatch(render(c),/private/);
 c.requestClear();assert.match(render(c),/<dialog[^>]*role="alertdialog"/);assert.match(render(c),/已保存的历史、未发送的草稿和角色资料会保留/);
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

test('chat explains unavailable online sending without hiding an unsaved draft', async () => {
 const c = new ChatWorkspaceController(undefined, undefined, {
  list: async () => ({ ok: true, models: [] }), send: async () => { throw Error('must not send'); }, cancel: async () => {},
 });
 c.syncCharacters([{ id: 'pet-one', name: '龙妹' }]); await c.refreshModels(); c.edit('未保存的草稿');
 const html = render(c);
 assert.match(html, /未配置模型[\s\S]*在线发送需先在「模型管理」配置模型/);
 assert.match(html, /data-empty="false"/);
 assert.equal(c.getSnapshot().session.draft, '未保存的草稿');
 assert.match(html, /<button[^>]*disabled=""[^>]*aria-label="发送消息"/);
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


test('the selected pet gets the confirmed welcome scene and only a multi-instance chat gets a picker', () => {
 const c = create();
 const view = () => renderToStaticMarkup(createElement(ChatPage, { state: c.getSnapshot(), controller: c, reference: dafeiyu }));
 c.syncCharacters([{ id: 'fish', name: '大肥鱼' }]);
 assert.match(view(), /<h1>聊天<\/h1>[\s\S]*和桌边的伙伴说说话/);
 assert.match(view(), /chat-role[\s\S]*pet-app:\/\/workspace\/covers\/local\.community\.dafeiyu/);
 assert.match(view(), /data-pet-art="dafeiyu"/);
 assert.match(view(), /class="chat-portrait"/);
 assert.doesNotMatch(view(), /<select[^>]*aria-label="聊天角色"|本机查询快捷短句|chat-welcome-mark/);
 c.syncCharacters([{ id: 'fish', name: '大肥鱼' }, { id: 'copy', name: '大肥鱼 · 分身' }]);
 assert.match(view(), /<select[^>]*aria-label="聊天角色"/);
});

test('an empty chat offers navigation to pets instead of a composer or pretend role', () => {
 const c = new ChatWorkspaceController();
 const html = renderToStaticMarkup(createElement(ChatPage, { state: c.getSnapshot(), controller: c, onOpenPets() {} }));
 assert.match(html, /还没有可以聊天的桌宠/);
 assert.match(html, /在「桌宠」添加一只伙伴/);
 assert.match(html, /前往桌宠/);
 assert.doesNotMatch(html, /我的桌宠/);
 assert.doesNotMatch(html, /aria-label="聊天消息"|chat-model-toggle|今天想和桌宠聊点什么|聊天选项/);
});

test('welcome shortcuts are visible only with the local bridge and disappear when the conversation starts', async () => {
 const c = new ChatWorkspaceController(undefined, {localChatContext: async ({petID}) => ({ok:true,petID,text:'合成身份'})});
 c.syncCharacters([{ id: 'one', name: '龙妹' }]);
 const view = () => renderToStaticMarkup(createElement(ChatPage, { state: c.getSnapshot(), controller: c, reference: longmei }));
 assert.match(view(), /本机查询快捷短句[\s\S]*你是谁[\s\S]*查看目标进度[\s\S]*查角色知识[\s\S]*查个人记忆/);
 c.edit('查角色知识：');
 assert.match(view(), /本机查询[\s\S]*请输入查询关键词/);
 assert.doesNotMatch(view(), /可能产生费用/);
 c.edit('你是谁？'); await c.send();
 const html = view();
 assert.match(html, /chat-message-assistant[\s\S]*chat-avatar[\s\S]*龙妹[\s\S]*本机资料[\s\S]*合成身份/);
 assert.doesNotMatch(html, /chat-portrait|本机查询快捷短句/);
});

test('workspace reserves the Pet Agent panel for the low-frequency chat menu', async () => {
 const c = create();
 const html = await renderWorkspace(createElement(WorkspaceView, {...diagnostics, initialPage: 'chat', chatState: c.getSnapshot(), chatController: c}));
 const sidebar = html.match(/<aside class="sidebar"[\s\S]*?<\/aside>/)?.[0];
 assert.ok(sidebar);
 assert.doesNotMatch(sidebar, /aria-label="角色"|>身份<|>记忆<|>能力与目标<|>桌宠 Agent</);
 const menu = renderToStaticMarkup(createElement(ChatPage, {state: c.getSnapshot(), controller: c, onOpenPetAgent() {}}));
 assert.match(menu, /<details class="chat-options"[\s\S]*aria-haspopup="dialog"[^>]*>桌宠 Agent<\/button>/);
 assert.doesNotMatch(menu, />角色资料<\/button>|role="tab"/);
 c.syncCharacters([]);
 const empty = renderToStaticMarkup(createElement(ChatPage, {state: c.getSnapshot(), controller: c, onOpenPetAgent() {}}));
 assert.doesNotMatch(empty, />桌宠 Agent<\/button>/);
});

test('draft-only Markdown preview removes HTML and never creates a link or image URL', async () => {
 const Preview = (await import('../src/ChatDraftPreview.tsx')).default;
 const html = renderToStaticMarkup(createElement(Preview, { text: '**加粗**\n\n> 引用\n\n[示例](https://external.invalid)\n\n![图片](https://external.invalid/pic)\n\n<script>raw-html</script>' }));
 assert.match(html, /<strong>加粗<\/strong>/);
 assert.match(html, /<blockquote>[\s\S]*引用/);
 assert.match(html, /示例[\s\S]*图片/);
 assert.doesNotMatch(html, /<a |<img|href=|src=|raw-html|external\.invalid/);
});

test('composer and adjacent memory proposal disclose the local route and require explicit confirmation', async () => {
 const c = new ChatWorkspaceController(undefined, undefined, undefined, {
  readMemories: async ({ petID }) => ({ ok: true, snapshot: { schemaVersion: 1, petID, revision: 0, records: [] } }),
  saveChatMemory: async () => assert.fail('render and send must not confirm the proposal'),
 });
 c.syncCharacters([{ id: 'pet-one', name: '龙妹' }]);
 assert.match(render(c), /记住一件事/);
 assert.ok(c.prefillLocalShortcut('记住：'));
 assert.match(render(c), /本机记忆 · 不发送到模型/);
 assert.match(render(c), /disabled="" aria-label="生成本机记忆提案"/);
 c.edit('记住：示例 <b>正文</b>');
 assert.equal(await c.send(), true);
 const html = render(c);
 assert.match(html, /data-turn-id="[^"]+"[\s\S]*给龙妹的记忆提案[\s\S]*示例 &lt;b&gt;正文&lt;\/b&gt;[\s\S]*保存为记忆[\s\S]*忽略/);
 assert.doesNotMatch(html, /已记住|<b>正文<\/b>/);
});

test('the chat options expose retained drafts by conversation label, without showing draft content', async () => {
 const c = new ChatWorkspaceController(undefined, undefined, {
  list: async () => ({ ok: true, models: [], persistentConversations: true }), cancel: async () => {},
  send: async () => { throw Error('must not send'); },
 }, undefined, true);
 c.syncCharacters([{ id: 'pet-one', name: '合成桌宠' }]); await c.refreshModels();
 const completedAt = 1700000000000;
 assert.equal(c.continueConversation('pet-one', { session: { id: crypto.randomUUID(), number: 14, completedAt },
  turns: [{ requestID: crypto.randomUUID(), user: '旧问题', assistant: '旧回答', completedAt }], hasEarlier: false }), true);
 c.edit('未发送的合成正文');
 assert.equal(c.returnToCurrentChat(), true);
 assert.equal(c.historyCleared('pet-one'), true);
 const html = render(c);
 assert.match(html, /<button[^>]*>恢复草稿 · 会话 14<\/button>/);
 assert.doesNotMatch(html, /未发送的合成正文/);
});
