import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { runAgentTask } from '../src/agent/task-runtime.ts';
import type { ModelReply } from '../src/models/types.ts';

const request = () => ({ taskID: randomUUID(), petID: 'pet-a', prompt: '整理附件', route: { connectionID: 'c', modelEntryID: 'm', fingerprint: 'a'.repeat(64) }, files: [{ name: 'file.txt', mediaType: 'text/plain' as const, data: '5L2g5aW9' }] });
const reply = (name: string, args: Record<string, string | number>): ModelReply => ({ message: { role: 'assistant', text: '', toolCalls: [{ id: randomUUID(), name, arguments: args }] }, stop: 'tools', usage: {} });
test('agent tool loop reads only selected files via task-local numeric IDs and produces review text', async () => {
 let calls = 0;
 const output = await runAgentTask(request(), new AbortController().signal, async input => {
  assert.doesNotMatch(input.system!, /桌宠甲|file\.txt/);
  if (++calls === 1) return reply('read_task_file', { file: 1, offset: 0 });
  assert.equal(input.messages.at(-1)?.role, 'tool');
  assert.match(input.messages.at(-1)!.text, /你好/);
  return { message: { role: 'assistant', text: '待审结果' }, stop: 'end', usage: {} };
 });
 assert.equal(output, '待审结果'); assert.equal(calls, 2);
});

test('unknown tools, path strings, and aborted attempts cannot result in a subsequent model call', async () => {
 for (const [name, args] of [['run_shell', {}], ['read_task_file', { file: '../test' }]] as const) {
  let calls = 0;
  await assert.rejects(runAgentTask(request(), new AbortController().signal, async () => { calls++; return reply(name, args); }), /invalid_response/);
  assert.equal(calls, 1);
 }
 const abort = new AbortController(); abort.abort();
 await assert.rejects(runAgentTask(request(), abort.signal, async () => assert.fail('aborted task must not dispatch')), /cancelled/);
});


test('file listing exposes task-local numbers and sizes, not local filenames', async () => {
 let calls = 0;
 await runAgentTask(request(), new AbortController().signal, async input => {
  if (++calls === 1) return reply('list_task_files', {});
  assert.deepEqual(JSON.parse(input.messages.at(-1)!.text), { files: [{ id: 1, characters: 2 }] });
  return { message: { role: 'assistant', text: '结果' }, stop: 'end', usage: {} };
 });
 assert.equal(calls, 2);
});
