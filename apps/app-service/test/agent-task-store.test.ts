import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AgentTaskStore } from '../src/agent/task-store.ts';

const route = { connectionID: 'c', modelEntryID: 'm', fingerprint: 'a'.repeat(64) };
const setup = async (t: test.TestContext) => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'pet-agent-task-')));
 t.after(() => rm(root, { recursive: true, force: true }));
 return root;
};
const record = (petID: string) => ({ taskID: randomUUID(), petID, route });
test('task storage admits one active attempt per pet, three total, and binds revisions and IDs', async t => {
 const store = new AgentTaskStore(await setup(t));
 try {
  const input = record('pet-a'), task = await store.create(input);
  assert.equal(await store.read('pet-b', input.taskID), undefined);
  await assert.rejects(store.create(record('pet-a')), /busy/);
  await store.create(record('pet-b')); await store.create(record('pet-c'));
  await assert.rejects(store.create(record('pet-d')), /busy/);
  await assert.rejects(store.transition({ ...task, attemptID: randomUUID() }, { status: 'running', phase: 'thinking', progress: 10 }), /conflict/);
  const running = await store.transition(task, { status: 'running', phase: 'thinking', progress: 10 });
  await assert.rejects(store.transition(task, { status: 'cancelled', phase: 'thinking', progress: 10 }), /conflict/);
  await store.transition(running, { status: 'completed', phase: 'review', progress: 100, result: '结果' });
  const list = await store.list('pet-a');
  assert.equal(list.length, 1); assert.equal(list[0]?.result, '结果');
 } finally { await store.close(); }
});

test('restart recovers interrupted tasks without storing file fields or replaying attempts', async t => {
 const root = await setup(t), store = new AgentTaskStore(root), input = record('pet-a');
 try { await store.create({ ...input, ...{ prompt: 'RAW-TASK-PROMPT-MARKER', files: [{ data: 'ATTACHMENT-BYTES-MARKER' }] } }); }
 finally { await store.close(); }
 const stored = await readFile(join(root, 'agent-tasks.sqlite'));
 assert.equal(stored.includes('ATTACHMENT-BYTES-MARKER') || stored.includes('RAW-TASK-PROMPT-MARKER'), false);
 const restarted = new AgentTaskStore(root);
 try {
  const recovered = await restarted.read(input.petID, input.taskID);
  assert.equal(recovered?.status, 'outcome-unknown');
  await assert.rejects(restarted.create(input), /conflict/);
 } finally { await restarted.close(); }
});
