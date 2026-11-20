import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createHarnessRuntime } from '../src/agent/harness-runtime.ts';

test('the product sandbox rejects private reads/writes, other ports, arbitrary execution and unbound Provider envelopes', { skip: process.platform !== 'darwin', timeout: 10_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pet-harness-canary-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canary = join(root, 'private.txt');
  await writeFile(canary, 'untouched', { mode: 0o600 });
  let hits = 0;
  const denied = createServer((_req, res) => { hits++; res.end(); });
  denied.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve, reject) => { denied.close(error => error ? reject(error) : resolve()); denied.closeAllConnections(); }));
  await once(denied, 'listening');
  const address = denied.address(); assert.ok(address && typeof address === 'object');
  const text = JSON.stringify({ canary, deniedPort: address.port });
  const worker = fileURLToPath(new URL('./fixtures/harness-sandbox-canary.mjs', import.meta.url));
  const run = createHarnessRuntime({ worker, privateRoots: [root] });
  let dispatches = 0;
  const result = await run(text, async admitted => {
    assert.equal(admitted, text); dispatches++;
    return '合成门禁通过';
  }, AbortSignal.timeout(8000));
  assert.equal(result, '合成门禁通过');
  assert.equal(dispatches, 1);
  assert.equal(hits, 0);
  assert.equal(await readFile(canary, 'utf8'), 'untouched');
});

test('on loss of its synthetic service owner the real SDK exits and the worker clears its turn directory', { skip: process.platform !== 'darwin', timeout: 15_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pet-sdk-owner-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = fileURLToPath(new URL('./fixtures/harness-owner.mts', import.meta.url));
  const owner = spawn(process.execPath, ['--import', 'tsx', fixture], {
    env: { PATH: '/usr/bin:/bin', TMPDIR: root }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exited = once(owner, 'exit');
  t.after(async () => {
    if (owner.pid && owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
    await exited;
  });
  const result = await Promise.race([once(owner, 'message'), exited.then(() => [])]);
  assert.deepEqual(result[0], { dispatched: true });
  const turns = async () => (await readdir(root)).filter(name => name.startsWith('pet-harness-'));
  const dirs = await turns();
  assert.equal(dirs.length, 1);
  assert.match(dirs[0]!, /^pet-harness-/);
  const groups = execFileSync('/bin/ps', ['-ax', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 1000 }).trim().split('\n')
    .map(row => row.trim().split(/\s+/).map(Number))
    .filter(([pid, parent, group]) => parent === owner.pid && Number.isSafeInteger(pid) && pid === group);
  assert.equal(groups.length, 1, 'expected a single owned detached SDK group');
  const pid = groups[0]![0]!;
  assert.ok(owner.kill('SIGKILL'));
  assert.deepEqual(await exited, [null, 'SIGKILL']);
  const deadline = performance.now() + 4500;
  let gone = false;
  while (performance.now() < deadline) {
    try { process.kill(-pid, 0); } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH'); gone = true;
    }
    if (gone && (await turns()).length === 0) break;
    await delay(25);
  }
  assert.ok(gone, 'owned SDK group still exists');
  assert.deepEqual(await turns(), []);
});
