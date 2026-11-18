import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { readCodexWindowBounds } from '../src/codex-window-bounds.ts';
import { alignedStartupBounds, startStartupAlignment } from '../src/startup-alignment.ts';

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const displays = [
  { bounds: rect(0, 0, 1440, 900), workArea: rect(0, 25, 1440, 835) },
  { bounds: rect(-1920, -420, 1920, 1080), workArea: rect(-1920, -395, 1920, 1055) },
];
const target = rect(-1700, -300, 1000, 800);
const placed = rect(-1700, -181, 1000, 562);
const bytes = (value: string) => Buffer.from(value);
const reply = (value: string, error = '') => ({ stdout: bytes(value), stderr: bytes(error) });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('geometry probe invokes only the fixed no-argument helper with bounded output, time and cancellation', async () => {
  const { signal } = new AbortController();
  const bounds = await readCodexWindowBounds('/synthetic/bundle', signal, async (file, args, options) => {
    assert.equal(file, join('/synthetic/bundle', 'codex-window-bounds'));
    assert.deepEqual(args, []);
    assert.deepEqual(options, { encoding: 'buffer', shell: false, env: { LC_ALL: 'C' }, timeout: 750,
      maxBuffer: 64, killSignal: 'SIGKILL', signal });
    return reply('v1 -1700 -300 1000 800\n');
  });
  assert.deepEqual(bounds, target);
});

test('geometry probe discards malformed, oversized, noisy, or out of range replies', async () => {
  const { signal } = new AbortController();
  for (const text of ['', 'none\n', 'v2 0 0 600 500\n', 'v1 0 0 600 500', 'v1 0 0 600 500\nsecret\n',
    'v1 0 0 600 500\r\n', 'v1 1e2 0 600 500\n', 'v1 0 0 600.2 500\n', 'v1 0 0 600 500\n\n',
    'v1 0 0 600 500\n'.replace('v', '\u00f6'), 'v1 0 0 600 500\n'.replace('500', '5'.repeat(75)),
    'v1 131073 0 600 500\n', 'v1 0 0 319 200\n', 'v1 0 0 320 199\n', 'v1 0 0 16385 500\n']) {
    assert.equal(await readCodexWindowBounds('/synthetic', signal, async () => reply(text)), undefined, text);
  }
  assert.equal(await readCodexWindowBounds('/synthetic', signal, async () => reply('v1 0 0 600 500\n', 'unexpected')), undefined);
  assert.equal(await readCodexWindowBounds('/synthetic', signal, async () => { throw new Error('synthetic timeout'); }), undefined);
});

test('geometry probe skips a cancelled command and drops output delivered after cancellation', async () => {
  const controller = new AbortController();
  assert.equal(await readCodexWindowBounds('/synthetic', controller.signal, async () => {
    controller.abort();
    return reply('v1 0 0 600 500\n');
  }), undefined);
  let runs = 0;
  await readCodexWindowBounds('/synthetic', controller.signal, async () => { runs++; return reply('v1 0 0 600 500\n'); });
  assert.equal(runs, 0);
});

test('placement uses logical coordinates and fits the original ratio within the matched window', () => {
  assert.deepEqual(alignedStartupBounds(target, displays), placed);
  assert.deepEqual(alignedStartupBounds(rect(0, 30, 1400, 800), displays), rect(60, 70, 1280, 720));
  assert.deepEqual(alignedStartupBounds(rect(120, 25, 700, 225), displays), rect(270, 25, 400, 225));
});

test('placement rejects offscreen, cross-display, mirrored ambiguity, and full-display rectangles', () => {
  assert.equal(alignedStartupBounds(rect(2000, 25, 800, 400), displays), undefined);
  assert.equal(alignedStartupBounds(rect(-400, 50, 800, 400), displays), undefined);
  assert.equal(alignedStartupBounds(rect(20, 0, 900, 400), displays), undefined);
  assert.equal(alignedStartupBounds(target, [displays[1]!, displays[1]!]), undefined);
  const full = rect(0, 0, 1440, 900);
  assert.equal(alignedStartupBounds(full, [{ bounds: full, workArea: full }]), undefined);
});

function clock() {
  const waiting = new Map<number, () => void>();
  const schedule = (ms: number, run: () => void) => {
    assert.equal(waiting.has(ms), false, `duplicate timer ${ms}`);
    waiting.set(ms, run);
    return () => { waiting.delete(ms); };
  };
  return { schedule, waiting, fire(ms: number) {
    const run = waiting.get(ms);
    assert.ok(run, `missing timer ${ms}`);
    waiting.delete(ms);
    run();
  } };
}

test('alignment samples serially, waits for consecutive stable geometry and moves only once', async () => {
  const timer = clock(), moves: object[] = [];
  let pending: ((value: typeof target | undefined) => void) | undefined;
  const close = startStartupAlignment({ schedule: timer.schedule, displays: () => displays,
    apply: bounds => moves.push(bounds), read: () => new Promise(resolve => { pending = resolve; }) });
  timer.fire(0);
  assert.deepEqual([...timer.waiting.keys()], [8000]);
  pending!(target); await tick();
  assert.deepEqual(moves, []);
  timer.fire(500); pending!(undefined); await tick();
  timer.fire(500); pending!(target); await tick();
  assert.deepEqual(moves, []);
  timer.fire(500); pending!(target); await tick();
  assert.deepEqual(moves, [placed]);
  assert.equal(timer.waiting.size, 0);
  close();
});

test('closing playback or reaching the deadline aborts a pending read and discards late geometry', async () => {
  for (const reason of ['close', 'deadline']) {
    const timer = clock();
    let moves = 0;
    let pending!: (value: typeof target) => void, signal!: AbortSignal;
    const close = startStartupAlignment({ schedule: timer.schedule, displays: () => displays,
      apply: () => { moves++; }, read: current => new Promise(resolve => { pending = resolve; signal = current; }) });
    timer.fire(0); pending(target); await tick();
    timer.fire(500);
    if (reason === 'deadline') timer.fire(8000); else close();
    assert.equal(signal.aborted, true);
    pending(target); await tick();
    assert.equal(moves, 0);
    assert.equal(timer.waiting.size, 0);
  }
});

test('unavailable geometry gives up after twelve reads without affecting playback', async () => {
  const timer = clock();
  let reads = 0, moves = 0;
  startStartupAlignment({ schedule: timer.schedule, displays: () => displays,
    apply: () => { moves++; }, read: async () => { reads++; throw new Error('synthetic failure'); } });
  for (let i = 0; i < 12; i++) { timer.fire(i === 0 ? 0 : 500); await tick(); }
  assert.equal(reads, 12);
  assert.equal(moves, 0);
  assert.equal(timer.waiting.size, 0);
});
