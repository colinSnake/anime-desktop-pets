import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLocalChatCommand } from '../src/local-chat.ts';

test('only the explicit local identity command is matched; natural identity questions stay ordinary text', () => {
  for (const suffix of ['', '?', '？']) {
    assert.deepEqual(parseLocalChatCommand(`  查看本机身份${suffix}  `), { intent: 'identity' });
  }
  for (const question of ['你是谁', '你是谁?', '你是谁？', '  你是谁？  ', '你是谁，能做什么？', '请介绍你是谁', '查看本机身份并打开文件']) {
    assert.equal(parseLocalChatCommand(question), undefined);
  }
});

test('other explicit commands and malformed local queries keep their local intent', () => {
  assert.deepEqual(parseLocalChatCommand(' 查看目标进度？ '), { intent: 'goals' });
  assert.deepEqual(parseLocalChatCommand('查角色知识：合成知识'), { intent: 'knowledge', query: '合成知识' });
  assert.deepEqual(parseLocalChatCommand('查个人记忆: 合成记忆'), { intent: 'memory', query: '合成记忆' });
  assert.equal(parseLocalChatCommand('查角色知识：'), 'invalid');
  assert.equal(parseLocalChatCommand('查个人记忆：'), 'invalid');
});
