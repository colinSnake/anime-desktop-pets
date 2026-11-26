import assert from 'node:assert/strict';
import test from 'node:test';
import { isChatListResult, isChatSendResult } from '../src/online-chat.ts';

const requestID = '00000000-0000-4000-8000-000000000000';
const success = { ok: true, requestID, text: '合成回答', replayable: true };

test('online chat reply only accepts bounded numeric input usage on a fresh successful result', () => {
 assert.ok(isChatSendResult(success, requestID));
 assert.ok(isChatSendResult({ ...success, usage: { inputTokens: 0 } }, requestID));
 assert.ok(isChatSendResult({ ...success, usage: { inputTokens: Number.MAX_SAFE_INTEGER } }, requestID));
 assert.ok(isChatSendResult({ ...success, recovered: true }, requestID));
 for (const usage of [null, {}, { inputTokens: -1 }, { inputTokens: '3' }, { inputTokens: 1.5 }, { inputTokens: Infinity }, { inputTokens: Number.MAX_SAFE_INTEGER + 1 }, { inputTokens: 3, outputTokens: 4 }]) {
  assert.equal(isChatSendResult({ ...success, usage }, requestID), false);
 }
 assert.equal(isChatSendResult({ ...success, recovered: true, usage: { inputTokens: 3 } }, requestID), false);
 assert.equal(isChatSendResult({ ok: false, error: 'unavailable', usage: { inputTokens: 3 } }, requestID), false);
});

test('online chat model option accepts only a positive saved context window within the config bound', () => {
 const option = { route: { connectionID: 'first', modelEntryID: 'one', fingerprint: 'a'.repeat(64) }, connectionName: '合成连接', modelName: '合成模型', ready: true, isDefault: true };
 assert.ok(isChatListResult({ ok: true, models: [option] }));
 for (const contextWindow of [1, 258_000, 2_147_483_647]) assert.ok(isChatListResult({ ok: true, models: [{ ...option, contextWindow }] }));
 for (const contextWindow of [null, 0, -1, 1.5, '258000', 2_147_483_648]) assert.equal(isChatListResult({ ok: true, models: [{ ...option, contextWindow }] }), false);
});
