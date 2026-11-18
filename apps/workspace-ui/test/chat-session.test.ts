import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatWorkspaceController, characterCount, validatedMessage, trimTranscript, requestHistory, type ChatTurn, type ChatRequest } from '../src/chat-session.ts';
import { ComposerKeyboard } from '../src/chat-input.ts';

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
