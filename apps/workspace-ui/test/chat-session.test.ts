import { textDraft } from '../src/chat-draft.ts';
import type { OnlineChatInput, ChatOption, ChatSendResult } from '../../../packages/contracts/src/online-chat.ts';
import type { ChatAttachment } from '../../../packages/contracts/src/chat-attachments.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatWorkspaceController, characterCount, validatedMessage, trimTranscript, requestHistory, type ChatTurn, type ChatRequest } from '../src/chat-session.ts';
import { ComposerKeyboard } from '../src/chat-input.ts';

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

const characters = [{ id: 'pet-one', name: '龙妹' }, { id: 'pet-two', name: '二号' }];
const models = [{ id: 'test-model', name: '合成模型' }];
const turn = (id: string, text: string, role: 'user' | 'assistant' = 'user'): ChatTurn => ({ id, text, role, createdAt: 0 });
function setup(reply?: (request: ChatRequest, signal: AbortSignal) => Promise<string>) {
 const controller = new ChatWorkspaceController(reply ? { models, reply } : undefined);
 controller.syncCharacters(characters);
 return controller;
}

test('message budget counts composed characters without truncating an invalid draft', () => {
 assert.equal(characterCount('👨‍👩‍👧‍👦e\u0301'), 2);
 assert.equal(validatedMessage('  你好\n世界  '), '你好\n世界');
 assert.equal(validatedMessage(' \n '), undefined);
 assert.equal(validatedMessage('字'.repeat(1201)), undefined);
 assert.equal(validatedMessage('👨‍👩‍👧‍👦'.repeat(1200))?.length, '👨‍👩‍👧‍👦'.repeat(1200).length);
});

test('transcript keeps stable IDs and the newest complete exchange; network history stays bounded', () => {
 const rows = Array.from({length: 16}, (_,i) => turn(String(i), '短消息'));
 assert.deepEqual(trimTranscript(rows).map(t => t.id), rows.slice(-12).map(t => t.id));
 const newest = [turn('user', 'hi'), turn('reply', '字'.repeat(7000), 'assistant')];
 assert.deepEqual(trimTranscript([...rows, ...newest]), newest);
 const history = requestHistory([...rows, ...newest]);
 assert.ok(history.length <= 12);
 assert.ok(history.reduce((sum,t) => sum + characterCount(t.text),0) <= 6000);
 assert.equal(history.at(-1)?.text.length, 1200);
 assert.equal(newest[1]!.text.length, 7000);
});

test('unconfigured chat never fakes a reply; drafts are isolated by saved instance and survive sync', async () => {
 const c = setup(); c.edit('第一份草稿');
 assert.equal(await c.send(), false);
 assert.equal(c.getSnapshot().session.turns.length, 0);
 assert.equal(c.getSnapshot().session.draft, '第一份草稿');
 c.selectCharacter('pet-two'); c.edit('第二份草稿'); c.selectCharacter('pet-one');
 assert.equal(c.getSnapshot().session.draft, '第一份草稿');
 c.syncCharacters([{id:'pet-one',name:'新名字'}, characters[1]!]);
 assert.equal(c.getSnapshot().characters[0]?.name,'新名字');
 assert.equal(c.getSnapshot().session.draft,'第一份草稿');
 c.selectCharacter('../old'); assert.equal(c.getSnapshot().selectedId,'pet-one');
});

test('reply snapshots model and history, coalesces sends, timestamps once and preserves newer editing', async () => {
 let finish!: (text: string) => void; const seen: ChatRequest[] = [];
 const c=setup(async request => { seen.push(request); return new Promise(resolve => {finish=resolve;}); });
 c.edit('第一问'); const pending=c.send();
 assert.equal(c.getSnapshot().session.pending,true);
 assert.equal(await c.send(),false);
 c.edit('下一问草稿'); c.selectModel('other-model');
 finish(' 回复 '); assert.equal(await pending,true);
 assert.equal(seen.length,1); assert.equal(seen[0]!.model,'test-model'); assert.deepEqual(seen[0]!.history,[]);
 assert.equal(c.getSnapshot().session.draft,'下一问草稿');
 assert.deepEqual(c.getSnapshot().session.turns.map(t=>[t.role,t.text]),[['user','第一问'],['assistant','回复']]);
 assert.ok(Number.isFinite(c.getSnapshot().session.turns[1]!.createdAt));
});

test('failure redacts errors and retries original history without duplicating the user turn or replacing edits', async () => {
 let fail=true; const seen:ChatRequest[]=[];
 const c=setup(async request=>{seen.push(request);if(fail)throw Error('/private/token');return '已回复';});
 c.edit('提问'); assert.equal(await c.send(),false);
 assert.equal(c.getSnapshot().session.draft,'提问');
 assert.doesNotMatch(c.getSnapshot().session.status,/private|token/);
 c.edit('未保存的新问题'); fail=false; assert.equal(await c.retry(),true);
 assert.equal(c.getSnapshot().session.draft,'未保存的新问题');
 assert.equal(c.getSnapshot().session.turns.filter(t=>t.role==='user').length,1);
 assert.deepEqual(seen[0]!.history,seen[1]!.history);
});

test('cancel invalidates late completion before abort, restores only an empty draft and supports retry', async () => {
 let finish!:(text:string)=>void; let signal!:AbortSignal;
 const c=setup(async(_request,s)=>{signal=s;return new Promise(resolve=>{finish=resolve;});});
 c.edit('等待回复'); const pending=c.send(); c.edit('继续编辑'); c.cancel();
 assert.equal(signal.aborted,true); assert.equal(c.getSnapshot().session.pending,false);
 finish('迟到回复'); assert.equal(await pending,false);
 assert.equal(c.getSnapshot().session.turns.length,1);
 assert.equal(c.getSnapshot().session.draft,'继续编辑');
 assert.equal(c.getSnapshot().session.failed,true);
});

test('character switches cancel the addressed request and late results never enter another session', async () => {
 let finish!:(text:string)=>void;
 const c=setup(async()=>new Promise(resolve=>{finish=resolve;}));
 c.edit('角色一问题'); const pending=c.send(); c.selectCharacter('pet-two'); c.edit('角色二草稿');
 finish('错误角色回复'); await pending;
 assert.equal(c.getSnapshot().session.turns.length,0);
 assert.equal(c.getSnapshot().session.draft,'角色二草稿');
 c.selectCharacter('pet-one'); assert.equal(c.getSnapshot().session.turns.length,1);
 assert.equal(c.getSnapshot().session.draft,'角色一问题');
});

test('clear is confirmed, cannot run while pending, and never clears the composer draft', async () => {
 const c=setup(async()=> '回复'); c.edit('问题'); await c.send(); c.edit('保留草稿');
 assert.equal(c.confirmClear(),false);
 c.requestClear(); assert.equal(c.getSnapshot().session.confirmingClear,true);
 c.cancelClear(); assert.equal(c.getSnapshot().session.turns.length,2);
 c.requestClear(); assert.equal(c.confirmClear(),true);
 assert.equal(c.getSnapshot().session.turns.length,0); assert.equal(c.getSnapshot().session.draft,'保留草稿');
});

test('keyboard policy protects IME closing Enter and routes only plain Enter to send', () => {
 const keys=new ComposerKeyboard();
 const event={key:'Enter',shiftKey:false,ctrlKey:false,metaKey:false,altKey:false,isComposing:false,keyCode:13};
 assert.equal(keys.action(event,true,0),'send');
 for(const patch of [{shiftKey:true},{ctrlKey:true},{metaKey:true},{altKey:true},{isComposing:true},{keyCode:229}]) assert.equal(keys.action({...event,...patch},true,0),'native');
 assert.equal(keys.action(event,false,0),'block');
 assert.equal(keys.action({...event,repeat:true},true,0),'block');
 keys.start();assert.equal(keys.action(event,true,5),'native');
 keys.end(10);assert.equal(keys.action(event,true,15),'native');assert.equal(keys.action(event,true,25),'send');
 assert.equal(keys.action({...event,key:'Escape'},true,30),'blur');
 assert.equal(keys.action({...event,key:'Tab'},true,30),'native');
});

test('pending requests refuse clear and canceled attempts cannot finish a later retry', async () => {
 const finishes: Array<(text:string)=>void> = [];
 const c=setup(async()=>new Promise(resolve=>finishes.push(resolve)));
 c.edit('问题'); const first=c.send();
 c.requestClear(); assert.equal(c.getSnapshot().session.confirmingClear,false);
 assert.equal(c.confirmClear(),false); assert.equal(c.getSnapshot().session.pending,true);
 c.cancel(); const retry=c.retry();
 finishes[0]!('已取消的回复'); assert.equal(await first,false);
 assert.equal(c.getSnapshot().session.pending,true);
 assert.equal(c.getSnapshot().session.turns.length,1);
 finishes[1]!('重试的回复'); assert.equal(await retry,true);
 assert.deepEqual(c.getSnapshot().session.turns.map(t=>t.text),['问题','重试的回复']);
});

test('removing a character cancels its request and does not resurrect its draft', async () => {
 let finish!:(text:string)=>void;
 const c=setup(async()=>new Promise(resolve=>{finish=resolve;}));
 c.edit('删除角色的问题');const request=c.send();c.syncCharacters([characters[1]!]);
 finish('旧角色回复');assert.equal(await request,false);
 c.syncCharacters(characters);c.selectCharacter('pet-one');
 assert.equal(c.getSnapshot().session.draft,'');assert.equal(c.getSnapshot().session.turns.length,0);
});

test('invalid replies become retryable failures instead of success and do not expose backend content', async () => {
 for (const text of ['   ', 'x'.repeat(256_001)]) {
  const c=setup(async()=>text);c.edit('保留提问');assert.equal(await c.send(),false);
  assert.equal(c.getSnapshot().session.failed,true);assert.equal(c.getSnapshot().session.pending,false);
  assert.equal(c.getSnapshot().session.turns.length,1);assert.equal(c.getSnapshot().session.draft,'保留提问');
 }
});

test('local chat only dispatches explicit commands and its exchanges never enter model history', async () => {
 const asked: unknown[] = [];
 const online: ChatRequest[] = [];
 const c = new ChatWorkspaceController({ models, reply: async request => { online.push(request); return '合成模型回复'; } }, {
  localChatContext: async input => { asked.push(input); return { ok: true, petID: input.petID, text: '本机合成知识' }; },
 });
 c.syncCharacters(characters);
 c.edit('查角色知识：合成密钥');
 assert.equal(await c.send(), false);
 assert.equal(asked.length + online.length, 0);
 c.edit('查角色知识：星图');
 assert.equal(await c.send(), true);
 assert.deepEqual(asked, [{ petID: 'pet-one', intent: 'knowledge', query: '星图' }]);
 assert.equal(c.getSnapshot().session.turns.at(-1)?.text, '本机合成知识');
 assert.deepEqual(requestHistory(c.getSnapshot().session.turns), []);
 c.edit('引用上一段');
 assert.equal(await c.send(), true);
 assert.deepEqual(online[0]?.history, []);
});

test('local-only chat retains unsupported drafts and cancels late or mismatched replies', async () => {
 let done!: (result: { ok: true; petID: string; text: string }) => void;
 const c = new ChatWorkspaceController(undefined, { localChatContext: () => new Promise(resolve => { done = resolve; }) });
 c.syncCharacters(characters);
 c.edit('随意聊天仍未接入');
 assert.equal(await c.send(), false);
 assert.equal(c.getSnapshot().session.draft, '随意聊天仍未接入');
 c.edit('查看目标进度');
 const first = c.send();
 c.selectCharacter('pet-two');
 done({ ok: true, petID: 'pet-one', text: '迟到合成回答' });
 assert.equal(await first, false);
 assert.equal(c.getSnapshot().session.turns.length, 0);
 c.selectCharacter('pet-one');
 assert.equal(c.getSnapshot().session.draft, '查看目标进度');
 const second = c.retry();
 done({ ok: true, petID: 'pet-two', text: '串角色内容' });
 assert.equal(await second, false);
 assert.doesNotMatch(JSON.stringify(c.getSnapshot()), /迟到合成回答|串角色内容/);
});

const onlineOptions = [
 { route: { connectionID: 'first', modelEntryID: 'one', fingerprint: 'a'.repeat(64) }, connectionName: '服务甲', modelName: '同名模型', ready: true, isDefault: true },
 { route: { connectionID: 'second', modelEntryID: 'one', fingerprint: 'b'.repeat(64) }, connectionName: '服务乙', modelName: '同名模型', ready: true, isDefault: false },
];
test('without a service-marked default, chat does not silently select an arbitrary online route', async () => {
 const options = [
  { route: { connectionID: 'first', modelEntryID: 'three', fingerprint: 'a'.repeat(64) }, connectionName: '服务甲', modelName: '模型三', ready: true, isDefault: false },
  { route: { connectionID: 'second', modelEntryID: 'one', fingerprint: 'b'.repeat(64) }, connectionName: '服务乙', modelName: '模型一', ready: true, isDefault: false },
 ];
 const sent: OnlineChatInput[] = [];
 const c = new ChatWorkspaceController(undefined, undefined, {
  list: async () => ({ ok: true, models: options }), cancel: async () => {},
  send: async input => { sent.push(input); return { ok: true, requestID: input.requestID, text: '默认回复', replayable: false }; },
 });
 c.syncCharacters(characters); await c.refreshModels();
 c.edit('不要自动使用不匹配的服务商'); assert.equal(await c.send(), false);
 assert.equal(sent.length, 0);
 c.selectModel(c.getSnapshot().models[0]!.id); assert.equal(await c.send(), true);
 assert.deepEqual(sent[0]?.route, options[0]!.route);
});

test('saved default is pinned; context and other destinations never feed the next model history', async () => {
 const sent: OnlineChatInput[] = [];
 const c = new ChatWorkspaceController(undefined, undefined, {
  list: async () => ({ ok: true, models: onlineOptions }), cancel: async () => {},
  send: async input => { sent.push(input); return { ok: true, requestID: input.requestID, text: '合成回复', replayable: sent.length !== 1 }; },
 });
 c.syncCharacters(characters); await c.refreshModels();
 c.edit('第一问'); assert.equal(await c.send(), true);
 assert.deepEqual(sent[0]?.route, { ...onlineOptions[0]!.route, useDefault: true });
 c.edit('第二问'); assert.equal(await c.send(), true); assert.deepEqual(sent[1]?.history, []);
 c.edit('第三问'); assert.equal(await c.send(), true); assert.deepEqual(sent[2]?.history, [{ user: '第二问', assistant: '合成回复' }]);
 c.selectModel(c.getSnapshot().models[1]!.id); c.edit('第四问'); assert.equal(await c.send(), true);
 assert.deepEqual(sent[3]?.route, onlineOptions[1]!.route); assert.deepEqual(sent[3]?.history, []);
 assert.equal(c.getSnapshot().session.turns.length, 8);
});

test('selected attachments are sent only with the current turn and clear after a verified reply', async () => {
 const sent: OnlineChatInput[] = [];
 const c = new ChatWorkspaceController(undefined, undefined, {
  approveMaterials: async () => ({ ok: true, grant: '11111111-1111-4111-8111-111111111111' }),
  list: async () => ({ ok: true, models: onlineOptions }), cancel: async () => {},
  send: async input => { sent.push(input); return { ok: true, requestID: input.requestID, text: '已读附件', replayable: false }; },
 });
 c.syncCharacters(characters); await c.refreshModels();
 const files: ChatAttachment[] = [{ name: 'notes.txt', mediaType: 'text/plain', data: '5L2g5aW9' }];
 assert.equal(c.setAttachments('pet-one', files), true);
 c.edit('请整理附件');
 assert.equal(await c.send(), false);
 assert.equal(sent.length, 0);
 assert.equal(c.getSnapshot().session.awaitingApproval, true);
 assert.equal(await c.resolveMaterialApproval(true), true);
 assert.deepEqual(sent[0]?.attachments, files);
 assert.deepEqual(c.getSnapshot().session.attachments, []);
 assert.equal(JSON.stringify(c.getSnapshot()).includes(files[0]!.data), false);
});

test('cancel and pet switch clear in-memory attachments and do not make them retryable', async () => {
 const sent: OnlineChatInput[] = [];
 const reply = deferred<ChatSendResult>();
 const c = new ChatWorkspaceController(undefined, undefined, {
  approveMaterials: async () => ({ ok: true, grant: '11111111-1111-4111-8111-111111111111' }),
  list: async () => ({ ok: true, models: onlineOptions }), cancel: async () => {},
  send: input => { sent.push(input); return reply.promise; },
 });
 c.syncCharacters(characters); await c.refreshModels();
 const files: ChatAttachment[] = [{ name: 'notes.txt', mediaType: 'text/plain', data: '5L2g5aW9' }];
 assert.equal(c.setAttachments('pet-one', files), true);
 c.edit('请整理附件');
 assert.equal(await c.send(), false);
 const pending = c.resolveMaterialApproval(true);
 await Promise.resolve();
 assert.deepEqual(sent[0]?.attachments, files);
 c.cancel();
 assert.deepEqual(c.getSnapshot().session.attachments, []);
 assert.equal(await c.retry(), false);
 reply.resolve({ ok: true, requestID: sent[0]!.requestID, text: '迟到回复', replayable: false });
 assert.equal(await pending, false);
 assert.equal(JSON.stringify(c.getSnapshot()).includes(files[0]!.data), false);

 assert.equal(c.setAttachments('pet-one', files), true);
 c.selectCharacter('pet-two');
 c.selectCharacter('pet-one');
 assert.deepEqual(c.getSnapshot().session.attachments, []);
});

test('a submitted online failure leaves the editor empty and can explicitly restore the frozen draft and selection', async () => {
 const reply = deferred<ChatSendResult>(), calls: OnlineChatInput[] = [];
 const c = new ChatWorkspaceController(undefined, undefined, { list: async () => ({ ok: true, models: onlineOptions }), cancel: async () => {},
  send: input => { calls.push(input); return reply.promise; } });
 c.syncCharacters(characters); await c.refreshModels();
 const draft = { text: ' 原稿 ', selection: { anchor: 4, focus: 1 } };
 assert.equal(c.editDraft('pet-one', draft), true);
 const pending = c.send();
 assert.equal(c.getSnapshot().session.draft, '');
 reply.resolve({ ok: false, error: 'invalid_response' });
 assert.equal(await pending, false);
 assert.equal(c.getSnapshot().session.draft, '');
 assert.equal(c.getSnapshot().session.turns.length, 1);
 assert.equal(c.getSnapshot().canRetry, true);
 assert.equal(calls.length, 1);
 c.restoreDraft();
 assert.deepEqual(c.getSnapshot().session.draftSnapshot, draft);
 assert.equal(await c.retry(), false);
 assert.equal(c.getSnapshot().session.draft, '');
 assert.equal(c.getSnapshot().session.turns.length, 1);
 assert.equal(calls.length, 2);
});

test('retry keeps newer editing even when its text equals the failed online turn', async () => {
 const c = new ChatWorkspaceController(undefined, undefined, { list: async () => ({ ok: true, models: onlineOptions }), cancel: async () => {},
  send: async () => ({ ok: false, error: 'invalid_response' }) });
 c.syncCharacters(characters); await c.refreshModels(); c.edit('同文');
 assert.equal(await c.send(), false);
 const newer = { text: '同文', selection: { anchor: 0, focus: 0 } };
 c.editDraft('pet-one', newer);
 assert.equal(await c.retry(), false);
 assert.deepEqual(c.getSnapshot().session.draftSnapshot, newer);
});

test('online retry does not silently replace a stale route and cancellation reaches the bridge', async () => {
 const sent: OnlineChatInput[] = [], cancelled: string[] = [];
 let options = onlineOptions;
 const reply = deferred<ChatSendResult>();
 const c = new ChatWorkspaceController(undefined, undefined, { list: async () => ({ ok: true, models: options }), cancel: async id => { cancelled.push(id); }, send: input => { sent.push(input); return reply.promise; } });
 c.syncCharacters(characters); await c.refreshModels(); c.edit('当前问题');
 const pending = c.send(); c.selectCharacter('pet-two');
 assert.deepEqual(cancelled, [sent[0]?.requestID]);
 reply.resolve({ ok: true, requestID: sent[0]!.requestID, text: '迟到回复', replayable: true });
 assert.equal(await pending, false);
 c.selectCharacter('pet-one'); options = [onlineOptions[1]!]; await c.refreshModels();
 assert.equal(await c.retry(), false); assert.equal(sent.length, 1);
 assert.equal(c.getSnapshot().session.draft, '');
 c.restoreDraft();
 assert.equal(c.getSnapshot().session.draft, '当前问题');
});


test('local shortcuts insert only into the current empty draft, without running a query', async () => {
 let calls = 0;
 const c = new ChatWorkspaceController(undefined, { localChatContext: async ({petID}) => {
  calls++; return {ok:true,petID,text:'合成资料'};
 } });
 c.syncCharacters([{ id: 'one', name: '龙妹' }, { id: 'two', name: '大肥鱼' }]);
 c.edit('手写草稿');
 assert.equal(c.prefillLocalShortcut('查个人记忆：'), false);
 assert.equal(c.getSnapshot().session.draft, '手写草稿');
 c.selectCharacter('two');
 assert.equal(c.prefillLocalShortcut('查角色知识：'), true);
 assert.equal(c.getSnapshot().session.draft, '查角色知识：');
 assert.equal(c.getSnapshot().session.turns.length, 0);
 assert.equal(calls, 0);
 c.selectCharacter('one');
 assert.equal(c.getSnapshot().session.draft, '手写草稿');
 const disconnected = new ChatWorkspaceController();
 disconnected.syncCharacters([{id:'one',name:'龙妹'}]);
 assert.equal(disconnected.prefillLocalShortcut('查看本机身份'), false);
});

test('editor drafts keep semantic offsets per pet, reject delayed cross-pet events and restore the exact failed snapshot', async () => {
 const c = setup(async () => { throw Error('synthetic'); });
 const saved = {text:' 原文\n保留空格 ', selection:{anchor:5,focus:1}};
 assert.equal(c.editDraft('pet-one', saved),true);
 saved.selection.focus = 0;
 c.selectCharacter('pet-two');
 assert.equal(c.editDraft('pet-one',saved),false);
 assert.deepEqual(c.getSnapshot().session.draftSnapshot,{text:'',selection:{anchor:0,focus:0}});
 c.selectCharacter('pet-one');
 assert.deepEqual(c.getSnapshot().session.draftSnapshot,{text:saved.text,selection:{anchor:5,focus:1}});
 assert.equal(await c.send(),false);
 assert.equal(c.getSnapshot().session.turns[0]?.text,saved.text.trim());
 assert.deepEqual(c.getSnapshot().session.draftSnapshot,{text:saved.text,selection:{anchor:5,focus:1}});
 c.edit('下一条');
 assert.equal(await c.retry(),false);
 assert.equal(c.getSnapshot().session.draft,'下一条');
});

const savedID = '8f000000-0000-4000-8000-000000000001';
const savedTurn = { requestID: '8f000000-0000-4000-8000-000000000002', user: '合成历史提问', assistant: '合成历史回复', completedAt: 1700000000000 };
const savedDetail = { session: { id: savedID, number: 14, completedAt: savedTurn.completedAt }, turns: [savedTurn], hasEarlier: false };

test('resuming is explicit, preserves per-session drafts, and sends the saved ID with the selected model', async () => {
 const sent: OnlineChatInput[] = [];
 const c = new ChatWorkspaceController(undefined, undefined, {
  list: async () => ({ ok: true, models: onlineOptions, persistentConversations: true }), cancel: async () => {},
  send: async input => { sent.push(input); return { ok: true, requestID: input.requestID, text: '续聊回复', replayable: true }; },
 }, undefined, true);
 c.syncCharacters(characters); await c.refreshModels();
 c.edit('当前聊天草稿');
 const oldKey = c.getSnapshot().session.editorKey;
 assert.equal(c.continueConversation('pet-two', savedDetail), false);
 assert.equal(c.continueConversation('pet-one', savedDetail), true);
 assert.equal(c.getSnapshot().session.title, '会话 14');
 assert.deepEqual(c.getSnapshot().session.turns.map(turn => turn.text), ['合成历史提问', '合成历史回复']);
 assert.equal(c.editDraft('pet-one', textDraft('迟到的旧输入'), oldKey), false);
 c.edit('这条是续聊草稿');
 assert.equal(await c.send(), false, 'the destination needs an explicit choice when opening saved history');
 c.returnToCurrentChat();
 assert.equal(c.getSnapshot().session.draft, '当前聊天草稿');
 assert.equal(c.continueConversation('pet-one', savedDetail), true);
 assert.equal(c.getSnapshot().session.draft, '这条是续聊草稿');
 c.selectModel(c.getSnapshot().models[1]!.id);
 assert.equal(sent.length, 0);
 assert.equal(await c.send(), true);
 assert.deepEqual(sent[0]?.route, onlineOptions[1]!.route);
 assert.deepEqual(sent[0]?.conversation, { id: savedID, mode: 'resume' });
 assert.deepEqual(sent[0]?.history, []);
 c.selectModel(c.getSnapshot().models[0]!.id); c.edit('再切另一个模型');
 assert.equal(await c.send(), true);
 assert.deepEqual(sent[1]?.conversation, sent[0]?.conversation);
 assert.deepEqual(c.getSnapshot().session.turns.slice(-2).map(turn => turn.text), ['再切另一个模型', '续聊回复']);
});

test('new durable turns keep one ID, do not switch in flight, and start afresh after clearing saved history', async () => {
 const sent: OnlineChatInput[] = [], cancelled: string[] = [];
 const reply = deferred<ChatSendResult>();
 const c = new ChatWorkspaceController(undefined, undefined, {
  list: async () => ({ ok: true, models: onlineOptions, persistentConversations: true }), cancel: async id => { cancelled.push(id); },
  send: async input => { sent.push(input); return sent.length === 1 ? reply.promise : { ok: true, requestID: input.requestID, text: '回复', replayable: true }; },
 }, undefined, true);
 c.syncCharacters(characters); await c.refreshModels();
 c.edit('第一问'); const pending = c.send();
 assert.equal(c.continueConversation('pet-one', savedDetail), false);
 assert.deepEqual(cancelled, []);
 assert.equal(sent[0]?.conversation?.mode, 'new');
 reply.resolve({ ok: true, requestID: sent[0]!.requestID, text: '回复', replayable: true });
 assert.equal(await pending, true);
 c.edit('第二问'); assert.equal(await c.send(), true);
 assert.deepEqual(sent[1]?.conversation, { id: sent[0]?.conversation?.id, mode: 'resume' });
 c.edit('清历史也保留这条草稿');
 assert.equal(c.historyCleared('pet-one'), true);
 assert.equal(c.getSnapshot().session.draft, '清历史也保留这条草稿');
 assert.equal(await c.send(), true);
 assert.equal(sent[2]?.conversation?.mode, 'new');
 assert.notEqual(sent[2]?.conversation?.id, sent[0]?.conversation?.id);
 assert.deepEqual(sent[2]?.history, []);
});

test('a preview opened during generation cannot replace the newer live reply after completion', async () => {
 const sent: OnlineChatInput[] = [];
 const reply = deferred<ChatSendResult>();
 const c = new ChatWorkspaceController(undefined, undefined, {
  list: async () => ({ ok: true, models: onlineOptions, persistentConversations: true }), cancel: async () => {},
  send: async input => { sent.push(input); return sent.length === 1 ? { ok: true, requestID: input.requestID, text: '先前回复', replayable: true } : reply.promise; },
 }, undefined, true);
 c.syncCharacters(characters); await c.refreshModels();
 c.edit('先前问题'); assert.equal(await c.send(), true);
 const oldPreview = { session: { id: sent[0]!.conversation!.id, number: 1, completedAt: savedTurn.completedAt },
  turns: [{ ...savedTurn, requestID: sent[0]!.requestID, user: '先前问题', assistant: '先前回复' }], hasEarlier: false };
 c.edit('新问题'); const pending = c.send();
 assert.equal(c.continueConversation('pet-one', oldPreview), false);
 reply.resolve({ ok: true, requestID: sent[1]!.requestID, text: '生成完成的新回复', replayable: true });
 assert.equal(await pending, true);
 assert.equal(c.continueConversation('pet-one', oldPreview), true);
 assert.equal(c.getSnapshot().session.turns.at(-1)?.text, '生成完成的新回复');
});

test('a detached draft cannot be discarded when switching to another saved conversation', async () => {
 const c = new ChatWorkspaceController(undefined, undefined, {
  list: async () => ({ ok: true, models: onlineOptions, persistentConversations: true }), cancel: async () => {},
  send: async () => ({ ok: false, error: 'invalid_request' }),
 }, undefined, true);
 c.syncCharacters(characters); await c.refreshModels();
 assert.equal(c.continueConversation('pet-one', savedDetail), true);
 c.edit('先留着这条草稿'); c.requestClear(); assert.equal(c.confirmClear(), true);
 const other = { ...savedDetail, session: { ...savedDetail.session, id: crypto.randomUUID(), number: 15 } };
 assert.equal(c.continueConversation('pet-one', other), false);
 assert.equal(c.getSnapshot().session.draft, '先留着这条草稿');
 c.edit(''); assert.equal(c.continueConversation('pet-one', other), true);
});

test('retry keeps its logical turn identifier even when the transport acknowledgement was lost', async () => {
 const sent: OnlineChatInput[] = [];
 const c = new ChatWorkspaceController(undefined, undefined, {
  list: async () => ({ ok: true, models: onlineOptions, persistentConversations: true }), cancel: async () => {},
  send: async input => {
   sent.push(input);
   return sent.length === 1 ? { ok: false, error: 'unavailable' } : { ok: true, requestID: input.requestID, text: '已提交的回复', replayable: true };
  },
 }, undefined, true);
 c.syncCharacters(characters); await c.refreshModels();
 c.edit('合成请求'); assert.equal(await c.send(), false);
 assert.equal(await c.retry(), true);
 assert.notEqual(sent[0]?.requestID, sent[1]?.requestID);
 assert.match(sent[0]?.turnID ?? '', /^[0-9a-f-]{36}$/);
 assert.equal(sent[0]?.turnID, sent[1]?.turnID);
 assert.deepEqual(sent[0]?.conversation, sent[1]?.conversation);
});

test('clearing saved history preserves other conversations’ draft text and selection behind a recovery entry', async () => {
 const sent: OnlineChatInput[] = [];
 const c = new ChatWorkspaceController(undefined, undefined, {
  list: async () => ({ ok: true, models: onlineOptions, persistentConversations: true }), cancel: async () => {},
  send: async input => { sent.push(input); return { ok: true, requestID: input.requestID, text: '新会话回复', replayable: true }; },
 }, undefined, true);
 c.syncCharacters(characters); await c.refreshModels();
 assert.equal(c.continueConversation('pet-one', savedDetail), true);
 const draft = { text: '还没发出的会话草稿', selection: { anchor: 2, focus: 5 } };
 c.editDraft('pet-one', draft);
 c.selectModel(c.getSnapshot().models[1]!.id);
 assert.equal(c.returnToCurrentChat(), true);
 c.edit('当前聊天草稿');
 assert.equal(c.historyCleared('pet-one'), true);
 assert.equal(c.getSnapshot().session.draft, '当前聊天草稿');
 const [parked] = c.getSnapshot().detachedDrafts ?? [];
 assert.equal(parked?.label, '会话 14');
 c.selectCharacter('pet-two');
 assert.deepEqual(c.getSnapshot().detachedDrafts, []);
 assert.equal(c.openDetachedDraft(parked!.id), false);
 c.selectCharacter('pet-one');
 assert.equal(c.openDetachedDraft(parked!.id), true);
 assert.deepEqual(c.getSnapshot().session.draftSnapshot, draft);
 assert.deepEqual(c.getSnapshot().session.turns, []);
 assert.equal(c.historyCleared('pet-one'), true, 'repeated clears do not erase the preserved draft');
 assert.equal(c.returnToCurrentChat(), true);
 assert.equal(c.getSnapshot().session.draft, '当前聊天草稿');
 assert.equal(c.openDetachedDraft(parked!.id), true);
 assert.equal(await c.send(), true);
 assert.equal(sent[0]?.conversation?.mode, 'new');
 assert.notEqual(sent[0]?.conversation?.id, savedID);
 assert.deepEqual(sent[0]?.route, onlineOptions[1]!.route);
 assert.deepEqual(sent[0]?.history, []);
});

test('sending the same failed durable turn after changing models reconciles it without duplicating the user message', async () => {
 const sent: OnlineChatInput[] = [];
 const c = new ChatWorkspaceController(undefined, undefined, {
  list: async () => ({ ok: true, models: onlineOptions, persistentConversations: true }), cancel: async () => {},
  send: async input => {
   sent.push(input);
   if (sent.length === 1) return { ok: false, error: 'unavailable' };
   if (sent.length === 2) return { ok: true, requestID: input.requestID, text: '已保存的原回复', replayable: true, recovered: true };
   return { ok: true, requestID: input.requestID, text: '新回复', replayable: true };
  },
 }, undefined, true);
 c.syncCharacters(characters); await c.refreshModels();
 assert.equal(c.continueConversation('pet-one', savedDetail), true);
 c.selectModel(c.getSnapshot().models[0]!.id); c.edit('合成问题');
 assert.equal(await c.send(), false);
 c.selectModel(c.getSnapshot().models[1]!.id);
 assert.equal(c.getSnapshot().canRetry, false);
 assert.equal(c.getSnapshot().session.draft, '');
 assert.equal(await c.send(), false);
 c.restoreDraft();
 assert.equal(await c.send(), true);
 assert.equal(sent[0]?.turnID, sent[1]?.turnID);
 assert.notEqual(sent[0]?.requestID, sent[1]?.requestID);
 assert.deepEqual(sent[0]?.conversation, sent[1]?.conversation);
 assert.deepEqual(sent[1]?.route, onlineOptions[1]!.route);
 assert.deepEqual(c.getSnapshot().session.turns.slice(-2).map(turn => turn.text), ['合成问题', '已保存的原回复']);
 assert.equal(c.getSnapshot().session.turns.filter(turn => turn.text === '合成问题').length, 1);
 assert.match(c.getSnapshot().session.status, /没有向模型发送/);
 c.edit('下一问'); assert.equal(await c.send(), true);
 assert.notEqual(sent[2]?.turnID, sent[1]?.turnID);
 assert.deepEqual(sent[2]?.route, onlineOptions[1]!.route);
});

test('a page of older messages cannot replace the latest detail when resuming a saved conversation', async () => {
 const c = new ChatWorkspaceController(undefined, undefined, {
  list: async () => ({ ok: true, models: onlineOptions, persistentConversations: true }), cancel: async () => {},
  send: async () => { throw Error('reading must not send'); },
 }, undefined, true);
 c.syncCharacters(characters); await c.refreshModels();
 c.edit('现有聊天草稿');
 const older = { ...savedDetail, before: crypto.randomUUID(), turns: [{ ...savedTurn, requestID: crypto.randomUUID(), user: '以前的提问' }] };
 assert.equal(c.continueConversation('pet-one', older), false);
 assert.equal(c.getSnapshot().session.draft, '现有聊天草稿');
 assert.equal(c.continueConversation('pet-one', savedDetail), true);
 assert.deepEqual(c.getSnapshot().session.turns.map(turn => turn.text), [savedTurn.user, savedTurn.assistant]);
});

test('chat thinking starts high, stays scoped to the selected route and freezes for retry', async () => {
 const sent: OnlineChatInput[] = [];
 const c = new ChatWorkspaceController(undefined, undefined, {
  list: async () => ({ ok: true, models: [
   { ...onlineOptions[0]!, reasoningLevels: ['low', 'high', 'xhigh'], reasoningEffort: 'high' }, onlineOptions[1]!,
  ] }), cancel: async () => {},
  send: async input => {
   sent.push(input);
   return sent.length === 1 ? { ok: false, error: 'upstream_unavailable' } : { ok: true, requestID: input.requestID, text: '合成回复', replayable: false };
  },
 });
 c.syncCharacters(characters); await c.refreshModels();
 assert.equal(c.getSnapshot().session.reasoningEffort, 'high');
 assert.equal(c.getSnapshot().models[0]?.providerName, '服务甲');
 c.selectReasoning('low'); c.selectReasoning('none');
 c.edit('合成问题'); assert.equal(await c.send(), false);
 c.selectReasoning('xhigh');
 assert.equal(await c.retry(), true);
 assert.deepEqual(sent.map(input => input.reasoningEffort), ['low', 'low']);
 c.selectCharacter('pet-two'); assert.equal(c.getSnapshot().session.reasoningEffort, 'high');
 c.selectCharacter('pet-one'); assert.equal(c.getSnapshot().session.reasoningEffort, 'xhigh');
 c.selectModel(c.getSnapshot().models[1]!.id);
 assert.equal(c.getSnapshot().session.reasoningEffort, undefined);
 c.edit('不支持思考'); assert.equal(await c.send(), true);
 assert.equal(sent.at(-1)?.reasoningEffort, undefined);
});

test('full permission can be selected before composing but never preapproves future attachments', async () => {
 const sent: OnlineChatInput[] = [], grants: OnlineChatInput[] = [];
 const c = new ChatWorkspaceController(undefined, undefined, {
  list: async () => ({ ok: true, models: onlineOptions }), cancel: async () => {},
  approveMaterials: async input => { grants.push(input); return { ok: true, grant: crypto.randomUUID() }; },
  send: async input => { sent.push(input); return { ok: true, requestID: input.requestID, text: '合成回复', replayable: false }; },
 });
 c.syncCharacters(characters); await c.refreshModels();
 const editor = c.getSnapshot().session.editorKey;
 const files: ChatAttachment[] = [{ name: 'notes.txt', mediaType: 'text/plain', data: '5L2g5aW9' }];
 assert.equal(c.setMaterialPermission(true, editor), true);
 assert.equal(c.getSnapshot().session.fullyAllowed, true);
 assert.equal(c.getSnapshot().session.awaitingApproval, undefined);
 assert.equal(grants.length, 0); assert.equal(sent.length, 0);
 c.edit('整理材料');
 assert.equal(c.getSnapshot().session.fullyAllowed, undefined);
 assert.equal(c.setMaterialPermission(true, editor), true);
 assert.equal(c.getSnapshot().session.fullyAllowed, true);
 assert.equal(c.setAttachments('pet-one', files, editor), true);
 assert.equal(c.getSnapshot().session.fullyAllowed, undefined);
 assert.equal(await c.send(), false);
 assert.equal(c.getSnapshot().session.awaitingApproval, true);
 assert.equal(grants.length, 0); assert.equal(sent.length, 0);
});

test('a full permission confirmation cannot authorize attachments changed while the warning was open', async () => {
 const c = new ChatWorkspaceController(undefined, undefined, {
  list: async () => ({ ok: true, models: onlineOptions }), cancel: async () => {},
  approveMaterials: async () => ({ ok: false, error: 'unavailable' }),
  send: async () => { assert.fail('unexpected outbound request'); },
 });
 c.syncCharacters(characters); await c.refreshModels();
 c.edit('整理材料');
 const { editorKey, materialPermissionKey } = c.getSnapshot().session;
 assert.ok(materialPermissionKey);
 c.syncCharacters(characters);
 assert.equal(c.getSnapshot().session.materialPermissionKey, materialPermissionKey);
 assert.equal(c.setAttachments('pet-one', [{ name: 'notes.txt', mediaType: 'text/plain', data: '5L2g5aW9' }], editorKey), true);
 assert.notEqual(c.getSnapshot().session.materialPermissionKey, materialPermissionKey);
 assert.equal(c.setMaterialPermission(true, editorKey, materialPermissionKey), false);
 assert.equal(c.getSnapshot().session.fullyAllowed, undefined);
 assert.equal(await c.send(), false);
 assert.equal(c.getSnapshot().session.awaitingApproval, true);
});

test('full permission resets on edits, and skipping an approval sends only the message', async () => {
 const sent: OnlineChatInput[] = [], grants: OnlineChatInput[] = [];
 const c = new ChatWorkspaceController(undefined, undefined, {
  list: async () => ({ ok: true, models: onlineOptions }), cancel: async () => {},
  approveMaterials: async input => { grants.push(input); return { ok: true, grant: crypto.randomUUID() }; },
  send: async input => { sent.push(input); return { ok: true, requestID: input.requestID, text: '合成回复', replayable: false }; },
 });
 c.syncCharacters(characters); await c.refreshModels();
 const files: ChatAttachment[] = [{ name: 'notes.txt', mediaType: 'text/plain', data: '5L2g5aW9' }];
 const editor = c.getSnapshot().session.editorKey;
 c.edit('整理材料'); c.setAttachments('pet-one', files, editor);
 assert.equal(c.setMaterialPermission(true, editor), true);
 assert.equal(c.getSnapshot().session.fullyAllowed, true);
 c.edit('新的问题');
 assert.equal(c.getSnapshot().session.fullyAllowed, undefined);
 assert.equal(await c.send(), false);
 assert.equal(c.getSnapshot().session.awaitingApproval, true);
 assert.equal(await c.resolveMaterialApproval(false), true);
 assert.equal(grants.length, 0); assert.equal(sent[0]?.attachments, undefined);
 assert.equal(sent[0]?.text, '新的问题');
 c.edit('整理附件'); c.setAttachments('pet-one', files, editor);
 assert.equal(c.setMaterialPermission(true, editor), true);
 assert.equal(await c.send(), true);
 assert.equal(grants.length, 1); assert.deepEqual(sent[1]?.attachments, files);
 assert.equal(c.getSnapshot().session.fullyAllowed, undefined);
});

test('project conversation stays pinned and changing conversations clears attachment permission but not the draft', async () => {
 const sent: OnlineChatInput[] = [];
 const c = new ChatWorkspaceController(undefined, undefined, {
  list: async () => ({ ok: true, models: onlineOptions, persistentConversations: true }), cancel: async () => {},
  approveMaterials: async () => ({ ok: false, error: 'unavailable' }),
  send: async input => { sent.push(input); return { ok: true, requestID: input.requestID, text: '合成回复', replayable: true }; },
 }, undefined, true);
 c.syncCharacters(characters); await c.refreshModels();
 const projectID = crypto.randomUUID();
 assert.equal(c.newConversation(projectID), true);
 c.edit('整理材料'); c.setAttachments('pet-one', [{ name: 'notes.txt', mediaType: 'text/plain', data: '5L2g5aW9' }]);
 assert.equal(c.setMaterialPermission(true, c.getSnapshot().session.editorKey), true);
 assert.equal(c.newConversation(), true);
 const saved = c.getSnapshot().detachedDrafts[0]!;
 assert.ok(c.openDetachedDraft(saved.id));
 assert.equal(c.getSnapshot().session.draft, '整理材料');
 assert.deepEqual(c.getSnapshot().session.attachments, []);
 assert.equal(c.getSnapshot().session.fullyAllowed, undefined);
 assert.equal(await c.send(), true);
 c.edit('继续讨论'); assert.equal(await c.send(), true);
 assert.equal(sent[0]?.conversation?.projectID, projectID);
 assert.deepEqual(sent[1]?.conversation, { ...sent[0]?.conversation, mode: 'resume' });
 assert.equal(c.newConversation(), true);
 c.edit('独立聊天'); assert.equal(await c.send(), true);
 assert.notEqual(sent[2]?.conversation?.id, sent[0]?.conversation?.id);
 assert.equal(sent[2]?.conversation?.projectID, undefined);
});

test('the explicit local identity shortcut stays local without a model call', async () => {
 const queries: string[] = [];
 let sends = 0;
 const c = new ChatWorkspaceController(undefined, { localChatContext: async ({ petID, intent }) => {
  queries.push(intent); return { ok: true, petID, text: '我是合成伙伴。尚未设置本机身份。' };
 } }, { list: async () => ({ ok: true, models: [] }), send: async () => { sends++; throw Error('local query must not dispatch'); }, cancel: async () => {} });
 c.syncCharacters([{ id: 'pet-one', name: '合成伙伴' }]);
 for (const question of ['查看本机身份', '查看本机身份？']) {
  c.edit(question);
  assert.equal(await c.send(), true);
  assert.equal(c.getSnapshot().session.draft, '');
  assert.equal(c.getSnapshot().session.turns.at(-1)?.localOnly, true);
  assert.match(c.getSnapshot().session.turns.at(-1)?.text ?? '', /我是合成伙伴/);
 }
 assert.deepEqual(queries, ['identity', 'identity']);
 assert.equal(sends, 0);
});

test('ordinary identity questions use the selected online model and never the local identity bridge', async () => {
 const sent: OnlineChatInput[] = [];
 const c = new ChatWorkspaceController(undefined, { localChatContext: async () => {
  assert.fail('ordinary identity questions must not query local identity');
 } }, { list: async () => ({ ok: true, models: onlineOptions }), send: async input => {
  sent.push(input); return { ok: true, requestID: input.requestID, text: '合成在线身份回复', replayable: true };
 }, cancel: async () => {} });
 c.syncCharacters(characters); await c.refreshModels();
 c.edit('你是谁？');
 assert.equal(await c.send(), true);
 assert.equal(sent.length, 1);
 assert.equal(sent[0]?.text, '你是谁？');
 assert.equal(c.getSnapshot().session.draft, '');
 assert.deepEqual(c.getSnapshot().session.turns.map(turn => [turn.text, turn.localOnly]), [
  ['你是谁？', undefined], ['合成在线身份回复', undefined],
 ]);
});

test('ordinary identity questions without models preserve the normal model-selection state and draft', async () => {
 const c = new ChatWorkspaceController(undefined, { localChatContext: async () => {
  assert.fail('ordinary identity questions must not query local identity');
 } }, { list: async () => ({ ok: true, models: [] }), send: async () => {
  assert.fail('no model is available');
 }, cancel: async () => {} });
 c.syncCharacters(characters); await c.refreshModels();
 const before = c.getSnapshot();
 c.edit('你是谁？');
 assert.equal(await c.send(), false);
 assert.equal(c.getSnapshot().available, before.available);
 assert.equal(c.getSnapshot().session.status, before.session.status);
 assert.equal(c.getSnapshot().session.model, undefined);
 assert.equal(c.getSnapshot().session.draft, '你是谁？');
 assert.deepEqual(c.getSnapshot().session.turns, []);
});

test('voice transcription fills only its unchanged empty local draft and never sends it', () => {
 const c = setup(async () => { assert.fail('draft import must not send'); });
 const initial = c.getSnapshot().session;
 c.edit('自己输入');
 assert.equal(c.importVoiceDraft('pet-one', initial.editorKey, initial.draftSnapshot, '合成转写'), false);
 c.edit('');
 assert.equal(c.importVoiceDraft('pet-one', initial.editorKey, initial.draftSnapshot, '合成转写'), false);
 const empty = c.getSnapshot().session;
 c.selectCharacter('pet-two');
 assert.equal(c.importVoiceDraft('pet-one', empty.editorKey, empty.draftSnapshot, '合成转写'), false);
 c.selectCharacter('pet-one');
 assert.equal(c.importVoiceDraft('pet-one', empty.editorKey, empty.draftSnapshot, 'invalid\nline'), false);
 assert.equal(c.importVoiceDraft('pet-one', empty.editorKey, empty.draftSnapshot, '合成转写'), true);
 assert.deepEqual(c.getSnapshot().session.draftSnapshot, textDraft('合成转写'));
 assert.equal(c.getSnapshot().session.turns.length, 0);
});

test('input usage follows the live pet, conversation and frozen model route, and clears with the conversation', async () => {
 const a = { ...onlineOptions[0]!, contextWindow: 258_000 };
 let options: ChatOption[] = [a, onlineOptions[1]!];
 let count = 151_000;
 const c = new ChatWorkspaceController(undefined, undefined, {
  list: async () => ({ ok: true, models: options, persistentConversations: true }), cancel: async () => {},
  send: async input => ({ ok: true, requestID: input.requestID, text: '合成回复', replayable: true, usage: { inputTokens: count } }),
 }, undefined, true);
 const usage = () => c.getSnapshot().session.contextUsage;
 const send = async () => { c.edit('合成问题'); assert.equal(await c.send(), true); };
 c.syncCharacters(characters); await c.refreshModels();
 const [first, second] = c.getSnapshot().models;
 assert.equal(usage()?.inputTokens, undefined);
 await send();
 assert.deepEqual(usage(), { inputTokens: 151_000, contextWindow: 258_000 });
 c.selectModel(second!.id);
 assert.equal(usage()?.inputTokens, undefined);
 count = 0; await send();
 assert.equal(usage()?.inputTokens, 0);
 assert.equal(usage()?.contextWindow, undefined);
 c.selectModel(first!.id);
 assert.equal(usage()?.inputTokens, 151_000);
 options = [{ ...a, contextWindow: 260_000 }, onlineOptions[1]!];
 await c.refreshModels();
 assert.deepEqual(usage(), { inputTokens: 151_000, contextWindow: 260_000 });
 c.selectCharacter('pet-two'); assert.equal(usage()?.inputTokens, undefined);
 c.selectCharacter('pet-one'); assert.equal(usage()?.inputTokens, 151_000);
 assert.equal(c.newConversation(), true); assert.equal(usage()?.inputTokens, undefined);
 count = 12; await send(); assert.equal(usage()?.inputTokens, 12);
 assert.equal(c.returnToCurrentChat(), true); assert.equal(usage()?.inputTokens, 151_000);
 count = 23; await send(); assert.equal(usage()?.inputTokens, 23);
 options = [{ ...a, route: { ...a.route, fingerprint: 'c'.repeat(64) } }, onlineOptions[1]!];
 await c.refreshModels(); assert.equal(usage()?.inputTokens, undefined);
 options = [a, onlineOptions[1]!]; await c.refreshModels(); assert.equal(usage()?.inputTokens, 23);
 c.requestClear(); assert.equal(c.confirmClear(), true); assert.equal(usage()?.inputTokens, undefined);
});

test('local, failed, cancelled and recovered replies do not overwrite current usage; a fresh reply without usage does', async () => {
 let answer: (input: OnlineChatInput) => Promise<ChatSendResult> = async input => ({ ok: true, requestID: input.requestID, text: '合成回复', replayable: true, usage: { inputTokens: 42 } });
 const c = new ChatWorkspaceController(undefined, { localChatContext: async ({ petID }) => ({ ok: true, petID, text: '本机角色' }) }, {
  list: async () => ({ ok: true, models: onlineOptions, persistentConversations: true }), cancel: async () => {}, send: input => answer(input),
 }, undefined, true);
 c.syncCharacters(characters); await c.refreshModels();
 const usage = () => c.getSnapshot().session.contextUsage?.inputTokens;
 c.edit('第一问'); assert.equal(await c.send(), true);
 c.edit('查看本机身份'); assert.equal(await c.send(), true); assert.equal(usage(), 42);
 answer = async () => ({ ok: false, error: 'rate_limited' });
 c.edit('第二问'); assert.equal(await c.send(), false); assert.equal(usage(), 42);
 answer = async input => ({ ok: true, requestID: input.requestID, text: '恢复的合成回复', replayable: true, recovered: true });
 assert.equal(await c.retry(), true); assert.equal(usage(), 42);
 const late = deferred<void>();
 answer = async input => { await late.promise; return { ok: true, requestID: input.requestID, text: '迟到回复', replayable: true, usage: { inputTokens: 999 } }; };
 c.edit('第三问'); const pending = c.send(); c.cancel(); late.resolve();
 assert.equal(await pending, false); assert.equal(usage(), 42);
 answer = async input => ({ ok: true, requestID: input.requestID, text: '无统计回复', replayable: true });
 c.edit('第四问'); assert.equal(await c.send(), true); assert.equal(usage(), undefined);
});
