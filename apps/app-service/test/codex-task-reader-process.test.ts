import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CodexTaskReaderProcess } from '../src/codex-task-reader-process.ts';

async function fixture(t: TestContext, replacement?: string) {
  const root = await mkdtemp(join(tmpdir(), 'anime-task-reader-'));
  const worker = join(root, 'task_reader_worker.py');
  const reader = new CodexTaskReaderProcess({ home: root, worker, guardian: resolve('apps/runtime-bridge/guardian.py'),
    timeoutMs: replacement ? 250 : 2500, python: process.env.PET_PYTHON });
  t.after(async () => { try { await reader.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  if (replacement) await writeFile(worker, replacement);
  else {
    await Promise.all(['task_reader_worker.py', 'task_reader.py'].map(name => copyFile(`apps/runtime-bridge/${name}`, join(root, name))));
    await copyFile('apps/pet-runtime/bailong/dragon_tasks.py', join(root, 'dragon_tasks.py'));
  }
  const day = join(root, '.codex', 'sessions', '2026', '11', '18');
  await mkdir(day, { recursive: true });
  const rollout = join(day, 'rollout-synthetic.jsonl');
  await writeFile(rollout, '{"type":"session_meta","payload":{"source":"vscode"}}\n');
  return { reader, rollout };
}

const record = JSON.stringify({ type: 'event_msg', payload: { type: 'turn_started', turn_id: 'synthetic-private-id', content: 'fixture text' } }) + '\n';

test('a supervised worker keeps one cursor per lease and returns only aggregate state', { skip: process.platform === 'win32' }, async t => {
  const { reader, rollout } = await fixture(t);
  const permit = new AbortController();
  assert.deepEqual(await reader.sample(permit.signal), { state: 'unknown', activeCount: 0, startSerial: 0 });
  await appendFile(rollout, record);
  assert.deepEqual(await reader.sample(permit.signal), { state: 'working', activeCount: 1, startSerial: 1 });
  permit.abort();
  await assert.rejects(reader.sample(permit.signal), /task_reader_unavailable/);
  const nextPermit = new AbortController();
  assert.deepEqual(await reader.sample(nextPermit.signal), { state: 'working', activeCount: 1, startSerial: 0 });
  await appendFile(rollout, record.replace('synthetic-private-id', 'synthetic-next-id'));
  assert.deepEqual(await reader.sample(nextPermit.signal), { state: 'working', activeCount: 2, startSerial: 2 });
});

for (const [name, body] of [
  ['oversized', 'print("synthetic-secret" * 300, flush=True)'],
  ['wrong schema', 'print(\'{"state":"idle","activeCount":0,"startSerial":0,"body":"synthetic"}\', flush=True)'],
  ['timeout', 'import time\ntime.sleep(10)'],
]) test(`the reader closes and sanitizes ${name} replies`, { skip: process.platform === 'win32' }, async t => {
  const { reader } = await fixture(t, `import sys\nsys.stdin.readline()\nsys.stdin.readline()\n${body}\n`);
  await assert.rejects(reader.sample(new AbortController().signal), /^Error: task_reader_unavailable$/);
  await reader.close();
});
