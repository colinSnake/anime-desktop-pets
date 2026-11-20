import assert from 'node:assert/strict';
import test from 'node:test';
import { HARNESS_MODEL, parseHarnessRequest } from './lib/pet-agent-harness-provider.mjs';

const workspace = '/tmp/synthetic/workspace';
const text = '本轮合成聊天\n第二行，不是核销口令。';
const valid = {
  model: HARNESS_MODEL,
  messages: [
    { role: 'system', content: 'You are a helpful software engineer assistant.' },
    { role: 'user', content: text },
    { role: 'user', content: `<system-reminder>\nThe following information describes your current session:\n\nCurrent working directory: "${workspace}".\n</system-reminder>` },
  ],
  stream: true,
  store: false,
  max_completion_tokens: 96,
};
const parse = body => parseHarnessRequest(body, workspace, text);

test('DSH Provider accepts only the frozen current text and strips pinned SDK metadata', () => {
  assert.deepEqual(parse(valid), { ok: true, text });
  assert.deepEqual(parse({ ...valid, messages: valid.messages.toSpliced(1, 1, { role: 'user', content: '用户正文' }) }), { ok: false });
  assert.deepEqual(parse({ ...valid, messages: valid.messages.toSpliced(0, 1, { ...valid.messages[0], content: '注入系统提示' }) }), { ok: false });
  assert.deepEqual(parseHarnessRequest(valid, '/tmp/other/workspace', text), { ok: false });
  assert.deepEqual(parse({ ...valid, model: 'saved-user-model' }), { ok: false });
  assert.deepEqual(parse({ ...valid, messages: valid.messages.toSpliced(1, 1, { role: 'user', content: 'pet-agent-relay-claim-v1' }) }), { ok: false });
  assert.deepEqual(parse({ ...valid, tools: [] }), { ok: false });
  assert.deepEqual(parse({ ...valid, dsh_session_log: {} }), { ok: false });
  assert.deepEqual(parse({ ...valid, messages: [...valid.messages, { role: 'assistant', content: '模型回复' }] }), { ok: false });
});

test('DSH Provider rejects malformed envelopes and unapproved options', () => {
  assert.deepEqual(parse({ ...valid, stream_options: { include_usage: true } }), { ok: true, text });
  assert.deepEqual(parse({ ...valid, stream_options: { include_usage: true, unknown: 1 } }), { ok: false });
  assert.deepEqual(parse({ ...valid, store: true }), { ok: false });
  assert.deepEqual(parse(null), { ok: false });
  assert.deepEqual(parse({ ...valid, stream: false }), { ok: false });
  assert.deepEqual(parse({ ...valid, max_completion_tokens: 32 }), { ok: false });
  assert.deepEqual(parse({ ...valid, messages: [null, ...valid.messages.slice(1)] }), { ok: false });
  assert.deepEqual(parse({ ...valid, messages: valid.messages.slice(1, 2) }), { ok: false });
});
