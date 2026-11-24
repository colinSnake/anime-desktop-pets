import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentStateStore } from '../src/agent/agent-state.ts';
import { createPiTextRuntime } from '../src/agent/pi-runtime.ts';
import { TextChatTurns } from '../src/agent/text-chat-runtime.ts';

const input = () => ({ requestID: randomUUID(), petID: 'test-pet', route: { connectionID: 'c', modelEntryID: 'm', fingerprint: 'a'.repeat(64) }, text: '合成正文', history: [] });
const signal = () => new AbortController().signal;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

async function setup(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'adpets-agent-admission-')));
  const state = new AgentStateStore(root);
  const turns = new TextChatTurns(createPiTextRuntime(), state);
  t.after(async () => { await turns.close(); await state.close(); await rm(root, { force: true, recursive: true }); });
  return { root, state, turns };
}

test('a chat publishes only after ledger completion and replay across service startups never dispatches', async t => {
  const { root, state, turns } = await setup(t);
  const turn = input();
  const output = await turns.run(turn, async () => {
    assert.equal((await state.status(turn.requestID))?.status, 'running');
    return '合成回答';
  }, signal());
  assert.equal(output, '合成回答');
  assert.equal((await state.status(turn.requestID))?.status, 'completed');
  await turns.close(); await state.close();
  const next = new AgentStateStore(root), restarted = new TextChatTurns(createPiTextRuntime(), next);
  try {
    await assert.rejects(restarted.run(turn, async () => assert.fail('replayed turn'), signal()), /invalid_request/);
  } finally { await restarted.close(); await next.close(); }
});

test('cancelled admission holds its pet slot until provider and metadata writes settle', async t => {
  const { state, turns } = await setup(t);
  const controller = new AbortController(), turn = input();
  const entered = deferred(), released = deferred();
  const run = turns.run(turn, async () => { entered.resolve(); await released.promise; return '晚到回答'; }, controller.signal);
  try {
    await Promise.race([entered.promise, run.then(() => assert.fail('provider not entered'))]); controller.abort();
    await assert.rejects(run, /cancelled/);
    await assert.rejects(turns.run(input(), async () => assert.fail('overlapping turn'), signal()), /busy/);
    assert.equal((await state.status(turn.requestID))?.status, 'running');
  } finally { released.resolve(); await turns.close(); }
  assert.equal((await state.status(turn.requestID))?.status, 'cancelled');
});

test('an unavailable ledger prevents provider and credential admission', async t => {
  const { turns, state } = await setup(t);
  await state.close();
  await assert.rejects(turns.run(input(), async () => assert.fail('storage failure must block dispatch'), signal()), /closed/);
});
