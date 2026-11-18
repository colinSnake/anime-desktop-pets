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
