import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatWorkspaceController, type ChatRequest } from '../src/chat-session.ts';
import type { CharacterRecordsBridge, Memory, RecordResult } from '../../../packages/contracts/src/character-records.ts';

const petID = 'pet-one', other = 'pet-two';
const text = '我偏好简短回复';
const turnText = `记住：${text}`;
const snapshot = (id: string, revision = 0, records: Memory[] = []) => ({ schemaVersion: 1 as const, petID: id, revision, records });
const now = '2026-11-20T00:00:00.000Z';
type Input = Parameters<CharacterRecordsBridge['saveChatMemory']>[0];
const stored = ({ messageID, text }: Input): Memory => ({ id: messageID, text, kind: '事实', source: '聊天确认', citation: '', version: '', status: 'confirmed', revision: 1, createdAt: now, updatedAt: now, confirmedAt: now });
function setup(save: CharacterRecordsBridge['saveChatMemory'], read: CharacterRecordsBridge['readMemories'] = async ({ petID }) => ({ ok: true, snapshot: snapshot(petID) })) {
 const model: ChatRequest[] = [];
 const c = new ChatWorkspaceController({ models: [{ id: 'fake', name: '合成模型' }], reply: async request => { model.push(request); return '答复'; } }, undefined, undefined, { readMemories: read, saveChatMemory: save });
 c.syncCharacters([{ id: petID, name: '龙妹' }, { id: other, name: '分身' }]);
 const send = async (draft = turnText) => { c.edit(draft); return c.send(); };
 const last = () => c.getSnapshot().session.turns.at(-1)!;
 return { c, send, last, model };
}

test('explicit memory is local even when malformed, unavailable or credential-like; ordinary chat still sends', async () => {
 const { c, send, last, model } = setup(async () => { throw Error('unexpected write'); });
 for (const raw of ['记住', '记住：', '记住:  ', '记住：我的密码是合成值', `记住：${'长'.repeat(301)}`, '记住：第一行\n第二行']) {
  assert.equal(await send(raw), false);
  assert.equal(c.getSnapshot().session.draft, raw);
 }
 assert.equal(model.length, 0);
 assert.equal(await send(), true);
 assert.equal(last().localOnly, true);
 assert.equal(last().memory?.state, 'ready');
 assert.equal(c.ignoreMemoryProposal(petID, last().id), true);
 assert.equal(last().memory?.state, 'ignored');
 assert.equal(await c.saveMemoryProposal(petID, last().id), false);
 assert.equal(await send('我们聊聊怎么记住：这个公式'), true);
 assert.deepEqual(model.map(x => [x.text, x.history]), [['我们聊聊怎么记住：这个公式', []]]);
 const offline = new ChatWorkspaceController({ models: [{ id: 'fake', name: '合成模型' }], reply: async () => { throw Error('must not send'); } });
 offline.syncCharacters([{ id: petID, name: '龙妹' }]); offline.edit(turnText);
 assert.equal(await offline.send(), false);
 assert.equal(offline.getSnapshot().session.turns.length, 0);
});

test('proposal is bound to its originating message and instance; only one explicit click dispatches', async () => {
 const writes: Input[] = [];
 let finish!: (value: RecordResult<'saveChatMemory'>) => void;
 const { c, send, last } = setup(input => { writes.push(input); return new Promise(resolve => { finish = resolve; }); });
 assert.equal(await send(), true);
 const messageID = last().id;
 assert.equal(writes.length, 0);
 c.selectCharacter(other);
 assert.equal(await c.saveMemoryProposal(petID, messageID), false);
 assert.equal(await c.saveMemoryProposal(other, messageID), false);
 assert.equal(c.ignoreMemoryProposal(other, messageID), false);
 c.edit('分身草稿'); c.selectCharacter(petID);
 const first = c.saveMemoryProposal(petID, messageID);
 assert.equal(await c.saveMemoryProposal(petID, messageID), false);
 assert.equal(c.ignoreMemoryProposal(petID, messageID), false);
 assert.deepEqual(writes, [{ petID, messageID, expectedRevision: 0, text }]);
 assert.equal(last().memory?.state, 'saving');
 c.selectCharacter(other);
 finish({ ok: true, snapshot: snapshot(petID, 1, [stored(writes[0]!)]), durability: 'confirmed' });
 assert.equal(await first, true);
 assert.equal(c.getSnapshot().session.draft, '分身草稿');
 assert.equal(c.getSnapshot().session.turns.length, 0);
 c.selectCharacter(petID);
 assert.equal(last().memory?.state, 'saved');
});

test('revision conflict requires an explicit read and a fresh click; uncertain write is never retried', async () => {
 let reads = 0;
 const writes: Input[] = [];
 const { c, send, last } = setup(async input => {
  writes.push(input);
  if (writes.length === 1) return { ok: false, error: 'conflict' };
  return { ok: true, snapshot: snapshot(petID, 2, [stored(input)]), durability: 'unconfirmed' };
 }, async () => ({ ok: true, snapshot: snapshot(petID, reads++, writes.length === 2 ? [stored(writes[1]!)] : []) }));
 await send(); const id = last().id;
 assert.equal(await c.saveMemoryProposal(petID, id), false);
 assert.equal(await c.saveMemoryProposal(petID, id), false);
 assert.equal(reads, 1);
 await c.refreshMemoryProposal(petID, id);
 assert.equal(writes.length, 1);
 assert.equal(last().memory?.state, 'ready');
 assert.equal(await c.saveMemoryProposal(petID, id), false);
 assert.deepEqual(writes.map(x => x.expectedRevision), [0, 1]);
 assert.equal(last().memory?.state, 'uncertain');
 await c.refreshMemoryProposal(petID, id);
 assert.equal(last().memory?.state, 'observed');
 assert.equal(await c.saveMemoryProposal(petID, id), false);
 assert.equal(writes.length, 2);
});

test('reply history and direct online DTOs refuse explicit memory commands without affecting model exchanges', async () => {
 const { validOnlineChatInput } = await import('../../../packages/contracts/src/online-chat.ts');
 const requests: import('../../../packages/contracts/src/online-chat.ts').OnlineChatInput[] = [];
 const route = { connectionID: 'example', modelEntryID: 'qa', fingerprint: 'a'.repeat(64) };
 const c = new ChatWorkspaceController(undefined, undefined, {
  list: async () => ({ ok: true, models: [{ route, connectionName: '连接', modelName: '模型', ready: true, isDefault: true }] }),
  send: async input => { requests.push(input); return { ok: true, requestID: input.requestID, text: '答复', replayable: true }; },
  cancel: async () => {},
 }, {
  readMemories: async () => ({ ok: true, snapshot: snapshot(petID) }),
  saveChatMemory: async input => ({ ok: true, snapshot: snapshot(petID, 1, [stored(input)]), durability: 'confirmed' }),
 });
 c.syncCharacters([{ id: petID, name: '龙妹' }]); await c.refreshModels();
 c.edit('第一轮'); assert.equal(await c.send(), true);
 c.edit(turnText); assert.equal(await c.send(), true);
 assert.equal(await c.saveMemoryProposal(petID, c.getSnapshot().session.turns.at(-1)!.id), true);
 c.edit('第二轮'); assert.equal(await c.send(), true);
 assert.equal(requests.length, 2);
 assert.deepEqual(requests[1]!.history, [{ user: '第一轮', assistant: '答复' }]);
 for (const command of [turnText, '记住：', '记住\n：秘密', '记住']) {
  assert.equal(validOnlineChatInput({ ...requests[1], text: command }), false);
  assert.equal(validOnlineChatInput({ ...requests[1], history: [{ user: command, assistant: '答复' }] }), false);
 }
});

test('a misaddressed acknowledgement or transport failure cannot claim success or resend the card', async () => {
 for (const wrong of [true, false]) {
  let writes = 0;
  const { c, send, last } = setup(async input => {
   writes++;
   if (!wrong) throw Error('private/internal');
   return { ok: true, snapshot: snapshot(other, 1, [stored(input)]), durability: 'confirmed' };
  });
  await send(); const id = last().id;
  assert.equal(await c.saveMemoryProposal(petID, id), false);
  assert.equal(last().memory?.state, 'uncertain');
  await c.refreshMemoryProposal(petID, id);
  assert.equal(last().memory?.state, 'not-observed');
  assert.equal(await c.saveMemoryProposal(petID, id), false);
  assert.equal(writes, 1);
 }
});

test('clear and removal discard pending proposal reads without writing or reviving a card', async () => {
 for (const remove of [false, true]) {
  let finish!: (value: RecordResult<'readMemories'>) => void;
  const { c, send, last } = setup(async () => assert.fail('must not write'), () => new Promise(resolve => { finish = resolve; }));
  const sending = send(); const id = last().id;
  c.edit('新草稿');
  if (remove) c.syncCharacters([{ id: other, name: '分身' }]);
  else {
   c.requestClear(); assert.equal(c.confirmClear(), true);
   assert.equal(c.getSnapshot().session.draft, '新草稿');
  }
  finish({ ok: true, snapshot: snapshot(petID) }); await sending;
  assert.deepEqual(c.getSnapshot().session.turns, []);
  assert.equal(await c.saveMemoryProposal(petID, id), false);
 }
});
