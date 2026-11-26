import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatIPC } from '../src/chat-ipc.ts';
import type { OnlineChatInput, ChatSendResult } from '../../../packages/contracts/src/online-chat.ts';

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

const input: OnlineChatInput = { requestID: '0f000000-0000-4000-8000-000000000001', petID: 'pet-a', text: '合成输入', history: [], route: { connectionID: 'one', modelEntryID: 'model', fingerprint: 'a'.repeat(64) } };
test('chat IPC requires a trusted frame and a fixed payload; cancel is scoped to the active request', async () => {
  const late = deferred<ChatSendResult>(); let signal: AbortSignal | undefined;
  const bridge = new ChatIPC({ listChatModels: async () => ({ ok: true, models: [] }), sendOnlineChat: async (_input, owned) => { signal = owned; return late.promise; } });
  assert.deepEqual(await bridge.invoke('send', false, [input]), { ok: false, error: 'invalid_request' });
  assert.deepEqual(await bridge.invoke('list', true, [123]), { ok: false, error: 'invalid_request' });
  assert.deepEqual(await bridge.invoke('send', true, [{ ...input, url: 'https://test.invalid' }]), { ok: false, error: 'invalid_request' });
  assert.equal(signal, undefined);
  const pending = bridge.invoke('send', true, [input]);
  await bridge.invoke('cancel', false, [input.requestID]);
  await bridge.invoke('cancel', true, [crypto.randomUUID()]);
  assert.equal((signal as AbortSignal | undefined)?.aborted, false);
  await bridge.invoke('cancel', true, [input.requestID]);
  assert.equal((signal as AbortSignal | undefined)?.aborted, true);
  late.resolve({ ok: true, requestID: input.requestID, replayable: true, text: '迟到回复' });
  assert.deepEqual(await pending, { ok: false, error: 'cancelled' });
});


test('history IPC requires a visible trusted frame, validates inputs, and drops results after hiding', async () => {
  const finish = deferred<unknown>();
  let calls = 0, visible = true;
  const bridge = new ChatIPC({ listChatModels: async () => ({ ok: true, models: [] }), sendOnlineChat: async () => ({ ok: false, error: 'unavailable' }),
    chatHistory: () => { calls++; return finish.promise; } });
  assert.deepEqual(await bridge.invokeHistory('clear', () => true, [{ petID: 'pet-a' }]), { ok: false, error: 'invalid_request' });
  assert.deepEqual(await bridge.invokeHistory('list', () => false, [{ petID: 'pet-a' }]), { ok: false, error: 'invalid_request' });
  assert.equal(calls, 0);
  const pending = bridge.invokeHistory('list', () => visible, [{ petID: 'pet-a' }]);
  assert.equal(calls, 1);
  visible = false;
  finish.resolve({ ok: true, page: { rows: [], nextBefore: null } });
  assert.deepEqual(await pending, { ok: false, error: 'unavailable' });
});

test('history detail IPC only returns the requested conversation and rejects extra arguments', async () => {
  const readID = '0f000000-0000-4000-8000-000000000005';
  const time = 1700000000000;
  const result = { ok: true, detail: { session: { id: readID, number: 2, completedAt: time }, hasEarlier: false,
    turns: [{ requestID: input.requestID, user: '合成提问', assistant: '合成回答', completedAt: time }] } };
  const bridge = new ChatIPC({ listChatModels: async () => ({ ok: true, models: [] }), sendOnlineChat: async () => ({ ok: false, error: 'unavailable' }),
    chatHistory: async () => result });
  const read = { petID: 'pet-a', id: readID };
  assert.deepEqual(await bridge.invokeHistory('detail', () => true, [{ ...read, query: 'SELECT' }]), { ok: false, error: 'invalid_request' });
  assert.deepEqual(await bridge.invokeHistory('detail', () => true, [{ ...read, id: input.requestID }]), { ok: false, error: 'unavailable' });
  assert.deepEqual(await bridge.invokeHistory('detail', () => true, [read]), result);
});

test('chat IPC delivers local recovery without relabeling an unsaved reply as recovered', async () => {
  const recovered = { ok: true, requestID: input.requestID, text: '已保存的回复', replayable: true, recovered: true } as const;
  let result: ChatSendResult = recovered;
  const bridge = new ChatIPC({ listChatModels: async () => ({ ok: true, models: [] }), sendOnlineChat: async () => result });
  const resend = { ...input, conversation: { id: crypto.randomUUID(), mode: 'resume' }, turnID: crypto.randomUUID() };
  assert.deepEqual(await bridge.invoke('send', true, [resend]), recovered);
  result = { ...recovered, historyStatus: 'unconfirmed' };
  assert.deepEqual(await bridge.invoke('send', true, [resend]), { ok: false, error: 'unavailable' });
});

test('paged history detail is bound to the requested cursor as well as the conversation', async () => {
  const id = crypto.randomUUID(), before = crypto.randomUUID(), completedAt = 1700000000000;
  const detail = { session: { id, number: 2, completedAt }, before, hasEarlier: false,
    turns: [{ requestID: crypto.randomUUID(), user: '合成提问', assistant: '合成回答', completedAt: completedAt - 1000 }] };
  let result: unknown = { ok: true, detail };
  const bridge = new ChatIPC({ listChatModels: async () => ({ ok: true, models: [] }), sendOnlineChat: async () => ({ ok: false, error: 'unavailable' }),
    chatHistory: async () => result });
  const read = { petID: 'pet-a', id, before };
  assert.deepEqual(await bridge.invokeHistory('detail', () => true, [read]), result);
  assert.deepEqual(await bridge.invokeHistory('detail', () => true, [{ ...read, before: '不合法' }]), { ok: false, error: 'invalid_request' });
  assert.deepEqual(await bridge.invokeHistory('detail', () => true, [{ ...read, before: crypto.randomUUID() }]), { ok: false, error: 'unavailable' });
  assert.deepEqual(await bridge.invokeHistory('detail', () => true, [{ petID: read.petID, id }]), { ok: false, error: 'unavailable' });
  result = { ok: true, detail: { ...detail, turns: [{ ...detail.turns[0], requestID: before }] } };
  assert.deepEqual(await bridge.invokeHistory('detail', () => true, [read]), { ok: false, error: 'unavailable' });
});

test('chat IPC accepts only current-turn attachment bytes, never paths or history attachment fields', async () => {
  const sent: OnlineChatInput[] = [];
  const grant = crypto.randomUUID();
  const bridge = new ChatIPC({ listChatModels: async () => ({ ok: true, models: [] }),
    approveChatMaterials: async () => ({ ok: true, grant }), sendOnlineChat: async (turn) => {
    sent.push(turn);
    return { ok: true, requestID: turn.requestID, text: '合成回复', replayable: false };
  } });
  const file = { name: 'notes.txt', mediaType: 'text/plain', data: '5L2g5aW9' } as const;
  const attachments = [file];
  const invalid = [
    { ...input, petID: '../other', attachments },
    { ...input, attachments: [{ ...file, path: '/private/example' }] },
    { ...input, attachments: [{ ...file, data: 'A'.repeat(7_000_000) }] },
    { ...input, history: [{ user: '历史问题', assistant: '历史回复', attachments }] },
  ];
  for (const payload of invalid) assert.deepEqual(await bridge.invoke('send', true, [payload]), { ok: false, error: 'invalid_request' });
  assert.equal(sent.length, 0);
  const turn = { ...input, attachments };
  assert.deepEqual(await bridge.invoke('send', true, [turn]), { ok: false, error: 'approval_required' });
  assert.deepEqual(await bridge.approveMaterials(() => false, [turn]), { ok: false, error: 'invalid_request' });
  assert.deepEqual(await bridge.approveMaterials(() => true, [turn]), { ok: true, grant });
  bridge.cancel(); // Delivery cannot survive a workspace hide after approval.
  const approved = { ...turn, materialGrant: grant };
  assert.deepEqual(await bridge.invoke('send', true, [approved]), { ok: false, error: 'approval_required' });
  assert.equal(sent.length, 0);
  assert.deepEqual(await bridge.approveMaterials(() => true, [turn]), { ok: true, grant });
  assert.ok((await bridge.invoke('send', true, [approved]))?.ok);
  assert.deepEqual(await bridge.invoke('send', true, [approved]), { ok: false, error: 'approval_required' });
  assert.deepEqual(sent[0]?.attachments, attachments);
});

test('existing chat IPC only passes the approved context window and fresh numeric usage', async () => {
  const reply = { ok: true, requestID: input.requestID, text: '合成回复', replayable: true, usage: { inputTokens: 0 } } as const;
  let result: ChatSendResult = reply;
  const listed = { ok: true, models: [{ route: input.route, connectionName: '连接', modelName: '模型', ready: true, isDefault: true, contextWindow: 258_000 }] } as const;
  const bridge = new ChatIPC({ listChatModels: async () => ({ ...listed, models: [...listed.models] }), sendOnlineChat: async () => result });
  assert.deepEqual(await bridge.invoke('list', true, []), listed);
  assert.deepEqual(await bridge.invoke('send', true, [input]), reply);
  result = { ...reply, recovered: true };
  assert.deepEqual(await bridge.invoke('send', true, [input]), { ok: false, error: 'unavailable' });
});
