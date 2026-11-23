import assert from 'node:assert/strict';
import test from 'node:test';
import { isAgentTaskExecutionPermission, isTaskInput, isTaskResult } from '../src/agent-tasks.ts';

const taskID = '1f000000-0000-4000-8000-000000000001', petID = 'pet-one';
const files = [{ name: 'notes.txt', mediaType: 'text/plain', data: '5L2g5aW9' }];
const input = { taskID, petID, route: { connectionID: 'a', modelEntryID: 'm', fingerprint: 'a'.repeat(64) }, prompt: '整理附件', files };
test('task admission accepts the default approval mode and explicit full mode', () => {
 assert.equal(isTaskInput('create', input), true);
 assert.equal(isTaskInput('create', { ...input, executionPermission: { mode: 'ask' } }), true);
 assert.equal(isTaskInput('create', { ...input, executionPermission: { mode: 'full' } }), true);
 assert.equal(isAgentTaskExecutionPermission({ mode: 'ask' }), true);
 assert.equal(isAgentTaskExecutionPermission({ mode: 'full' }), true);
 for (const bad of [{ ...input, writeConsent: true }, { ...input, executionPermission: { mode: 'unknown' } }, { ...input, executionPermission: { mode: 'full', persist: true } }, { ...input, route: { ...input.route, useDefault: true } }, { ...input, files: [{ ...files[0], path: 'notes.txt' }] }, { ...input, petID: '../evil' }]) {
  assert.equal(isTaskInput('create', bad), false);
 }
});

test('task replies bind ownership and forbid result text before completion', () => {
 const row = { petID, taskID, attemptID: '1f000000-0000-4000-8000-000000000002', revision: 1, status: 'completed', phase: 'review', progress: 100, result: '待审文本' };
 const read = { petID, taskID };
 assert.ok(isTaskResult('read', read, { ok: true, task: row }));
 for (const task of [{ ...row, petID: 'other' }, { ...row, status: 'running' }, { ...row, result: 'z'.repeat(25000) }, { ...row, files }, { ...row, prompt: '未持久化正文' }]) {
  assert.equal(isTaskResult('read', read, { ok: true, task }), false);
 }
});
