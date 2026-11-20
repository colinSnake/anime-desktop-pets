import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoFullscreenObserver, readVideoFullscreen } from '../src/video-fullscreen.ts';

test('fullscreen probe is fixed and accepts only one bounded bit', async () => {
  const controller = new AbortController();
  assert.equal(await readVideoFullscreen('/synthetic', controller.signal, async (file, args, options) => {
    assert.equal(file, '/synthetic/video-fullscreen');
    assert.deepEqual(args, []);
    assert.equal(options.shell, false);
    assert.equal(options.signal, controller.signal);
    return { stdout: Buffer.from('v1 1\n'), stderr: Buffer.alloc(0) };
  }), true);
  for (const stdout of ['v1 1\nx', 'v1 unknown\n', 'window-id']) {
    assert.equal(await readVideoFullscreen('/synthetic', controller.signal, async () => ({ stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) })), undefined);
  }
});

test('fullscreen polling is shared, latches through a transient sample and aborts when unused', async () => {
  let poll: (() => void) | undefined;
  let settle!: (result?: boolean) => void;
  const signals: AbortSignal[] = [];
  const observer = new VideoFullscreenObserver(signal => {
    signals.push(signal);
    return new Promise(resolve => { settle = resolve; });
  }, tick => { poll = tick; return () => { poll = undefined; }; });
  const left: boolean[] = [], right: boolean[] = [];
  const offLeft = observer.subscribe(value => left.push(value));
  const offRight = observer.subscribe(value => right.push(value));
  assert.equal(signals.length, 1);
  const step = async (value?: boolean) => { settle(value); await new Promise(setImmediate); poll?.(); };
  await step(true);
  await step(false);
  await step();
  await step(false);
  assert.deepEqual(left, [true]);
  await step(false);
  assert.deepEqual(left, [true, false]); assert.deepEqual(right, left);
  offLeft(); assert.ok(poll);
  offRight(); assert.equal(poll, undefined);
  assert.equal(signals.at(-1)?.aborted, true);
  settle(true); await new Promise(setImmediate);
  assert.deepEqual(left, [true, false]);
});
