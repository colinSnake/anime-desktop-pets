import assert from 'node:assert/strict';
import test from 'node:test';
import { SpeechPreview } from '../src/speech-preview.ts';
import type { SpeechResult } from '../../../packages/contracts/src/speech.ts';

const ok = { ok: true, speech: { state: 'enabled', hasReference: true } } as const;
const unavailable = { ok: false, error: 'unavailable' } as const;

test('local preview requires current eligibility and stop fences a delayed start', async () => {
  const calls: { revision: number; play: boolean }[] = [];
  let finish!: (result: SpeechResult) => void;
  const preview = new SpeechPreview(command => {
    calls.push(command);
    return command.play ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(ok);
  });
  assert.deepEqual(await preview.play(() => false), unavailable);
  assert.equal(calls.length, 0);
  let visible = true;
  const pending = preview.play(() => visible);
  assert.deepEqual(await preview.play(() => true), { ok: false, error: 'busy' });
  visible = false;
  assert.equal(await preview.stop(), true);
  finish(ok);
  assert.deepEqual(await pending, unavailable);
  assert.deepEqual(calls.slice(0, 2), [{ revision: 1, play: true }, { revision: 2, play: false }]);
});

test('failed preview cancellation blocks replay until an explicit successful stop', async () => {
  let canStop = false;
  const calls: { revision: number; play: boolean }[] = [];
  const preview = new SpeechPreview(async command => {
    calls.push(command); return command.play || canStop ? ok : unavailable;
  });
  assert.equal((await preview.play(() => true)).ok, true);
  assert.equal(await preview.stop(), false);
  const count = calls.length;
  assert.deepEqual(await preview.play(() => true), unavailable);
  assert.equal(calls.length, count);
  canStop = true;
  assert.equal(await preview.stop(), true);
  assert.equal((await preview.play(() => true)).ok, true);
  assert.equal(calls.at(-1)?.revision, 4);
});

test('a disconnected preview start is fenced and no exception escapes', async () => {
  const calls: { revision: number; play: boolean }[] = [];
  const preview = new SpeechPreview(command => {
    calls.push(command); throw Error('synthetic transport failure');
  });
  assert.deepEqual(await preview.play(() => true), unavailable);
  assert.deepEqual(calls, [{ revision: 1, play: true }, { revision: 2, play: false }]);
});

test('a completed audition does not require disabling the session before replay', async () => {
  const calls: { revision: number; play: boolean }[] = [];
  const preview = new SpeechPreview(async command => { calls.push(command); return ok; });
  assert.equal((await preview.play(() => true)).ok, true);
  assert.equal((await preview.play(() => true)).ok, true);
  assert.equal(await preview.stop(), true);
  assert.deepEqual(calls, [{ revision: 1, play: true }, { revision: 2, play: true }, { revision: 3, play: false }]);
});

test('eligibility lost while the command is in flight sends a higher stop automatically', async () => {
  const calls: { revision: number; play: boolean }[] = [];
  let focused = true, finish!: (result: SpeechResult) => void;
  const preview = new SpeechPreview(command => {
    calls.push(command); return command.play ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(ok);
  });
  const pending = preview.play(() => focused);
  focused = false; finish(ok);
  assert.deepEqual(await pending, unavailable);
  assert.deepEqual(calls, [{ revision: 1, play: true }, { revision: 2, play: false }]);
});

test('overlapping stop requests share one fence and block a new start until confirmed', async () => {
  const calls: { revision: number; play: boolean }[] = [];
  let finish!: (result: SpeechResult) => void;
  const preview = new SpeechPreview(command => {
    calls.push(command); return command.play ? Promise.resolve(ok) : new Promise(resolve => { finish = resolve; });
  });
  await preview.play(() => true);
  const stop = preview.stop();
  assert.equal(preview.stop(), stop);
  assert.deepEqual(await preview.play(() => true), { ok: false, error: 'busy' });
  finish(ok); assert.equal(await stop, true);
  assert.equal(calls.length, 2);
});
