import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { CodexObservation, type CodexObservationState } from '../src/codex-observation.ts';
import { readCodexPresence, type CodexPresence } from '../src/codex-presence.ts';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const states: CodexObservationState[] = [];
  const probes: { resolve(state: CodexPresence): void; reject(error: Error): void }[] = [];
  let scheduled: (() => void) | undefined;
  const watch = new CodexObservation({
    read: () => new Promise((resolve, reject) => probes.push({ resolve, reject })),
    changed: state => states.push(state),
    schedule: (callback, delay) => {
      assert.equal(delay, 10_000);
      assert.equal(scheduled, undefined);
      scheduled = callback;
      return () => { scheduled = undefined; };
    },
  });
  return { watch, states, probes, scheduled: () => !!scheduled, tick() {
    assert.ok(scheduled, 'requires a scheduled read');
    const callback = scheduled; scheduled = undefined; callback();
  } };
}

test('starts off; opt-in reads immediately and observes later changes without overlapping reads', async () => {
  const f = fixture();
  assert.equal(f.watch.state, 'off');
  await turn();
  assert.equal(f.probes.length, 0);
  assert.equal(f.scheduled(), false);
  f.watch.setEnabled(true); f.watch.setEnabled(true);
  assert.equal(f.watch.state, 'checking');
  await turn();
  assert.equal(f.probes.length, 1);
  assert.equal(f.scheduled(), false);
  f.probes[0]!.resolve('running');
  await turn();
  f.tick();
  await turn();
  assert.equal(f.watch.state, 'running');
  assert.equal(f.probes.length, 2);
  f.probes[1]!.resolve('not-detected');
  await turn();
  assert.deepEqual(f.states, ['checking', 'running', 'not-detected']);
  await f.watch.dispose();
  assert.equal(f.scheduled(), false);
});

test('failed reads replace stale presence with unknown and a later sample may recover', async () => {
  const f = fixture();
  f.watch.setEnabled(true);
  await turn(); f.probes[0]!.resolve('running');
  await turn(); f.tick();
  await turn(); f.probes[1]!.reject(new Error('synthetic private diagnostic'));
  await turn(); assert.equal(f.watch.state, 'unknown');
  f.tick();
  await turn(); f.probes[2]!.resolve('not-detected');
  await turn(); assert.equal(f.watch.state, 'not-detected');
  f.watch.setEnabled(false);
  assert.equal(f.watch.state, 'off');
  assert.equal(f.scheduled(), false);
});

test('stop then restart discards the old result and waits for its owned probe to settle', async () => {
  const f = fixture();
  f.watch.setEnabled(true);
  await turn();
  f.watch.setEnabled(false); f.watch.setEnabled(true);
  await turn();
  assert.equal(f.probes.length, 1);
  f.probes[0]!.resolve('running');
  await turn();
  assert.equal(f.probes.length, 2);
  assert.deepEqual(f.states, ['checking', 'off', 'checking']);
  f.probes[1]!.resolve('not-detected');
  await turn(); assert.equal(f.watch.state, 'not-detected');
  await f.watch.dispose();
});

test('stopping before the first read or disposing in flight prevents later work and menu updates', async () => {
  const f = fixture();
  f.watch.setEnabled(true); f.watch.setEnabled(false);
  await turn(); assert.equal(f.probes.length, 0);
  f.watch.setEnabled(true);
  await turn();
  let closed = false;
  const disposal = f.watch.dispose().then(() => { closed = true; });
  const states = [...f.states];
  f.watch.setEnabled(true);
  await turn(); assert.equal(closed, false);
  f.probes[0]!.resolve('running');
  await disposal;
  assert.deepEqual(f.states, states);
  assert.equal(f.watch.state, 'off');
  assert.equal(f.scheduled(), false);
  assert.equal(f.probes.length, 1);
});

test('native probe runs only the fixed binary with bounded arguments, environment and output', async () => {
  const directory = join(process.cwd(), 'synthetic-dist');
  assert.equal(await readCodexPresence(directory, async (file, args, options) => {
    assert.equal(file, join(directory, 'codex-presence'));
    assert.deepEqual(args, []);
    assert.deepEqual(options, { encoding: 'buffer', shell: false, env: { LC_ALL: 'C' }, timeout: 1500, maxBuffer: 64, killSignal: 'SIGKILL' });
    return { stdout: Buffer.from('running\n'), stderr: Buffer.alloc(0) };
  }), 'running');
  assert.equal(await readCodexPresence(directory, async () => ({stdout: Buffer.from('not-detected\n'), stderr: Buffer.alloc(0)})), 'not-detected');
});

test('native probe does not treat malformed, failed or noisy output as absence', async () => {
  for (const [stdout, stderr] of [['', ''], ['running\n42\n', ''], ['not-detected\n', 'private diagnostic'], [' running\n', '']]) {
    assert.equal(await readCodexPresence(process.cwd(), async () => ({stdout: Buffer.from(stdout!), stderr: Buffer.from(stderr!)})), 'unknown');
  }
  assert.equal(await readCodexPresence(process.cwd(), async () => { throw new Error('synthetic timeout'); }), 'unknown');
});
