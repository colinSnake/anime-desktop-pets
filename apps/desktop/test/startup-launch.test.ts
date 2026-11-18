import assert from 'node:assert/strict';
import test from 'node:test';
import { openInstalledCodex, StartupLaunch, type LaunchResult } from '../src/startup-launch.ts';
import { manageStartupPlayback, startupSignal, STARTUP_URL } from '../src/startup-playback.ts';
import type { CodexPresence } from '../src/codex-presence.ts';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(presence: () => Promise<CodexPresence>, video: 'valid' | 'unavailable' = 'valid') {
  const order: string[] = [];
  const opened = deferred<LaunchResult>(), played = deferred<void>();
  const launch = new StartupLaunch({ presence, open: () => { order.push('open'); return opened.promise; },
    play: () => { order.push('play'); if (video === 'unavailable') throw new Error('synthetic bad media');
      return { done: played.promise, close: () => { order.push('close'); played.resolve(); } }; },
    report: result => order.push(result) });
  return { launch, order, opened, played };
}

test('cold launch starts video and opens immediately; repeated commands stay merged until playback ends', async () => {
  const f = fixture(async () => 'not-detected');
  const done = f.launch.start();
  assert.equal(f.launch.start(), done);
  await turn(); assert.deepEqual(f.order, ['play', 'open']);
  f.opened.resolve('accepted'); await turn();
  assert.equal(f.launch.start(), done);
  f.played.resolve(); await done;
  assert.deepEqual(f.order, ['play', 'open', 'close']);
});

test('hot and uncertain launches open without video; missing/broken video also permits opening', async () => {
  for (const presence of ['running', 'unknown', 'not-detected'] as const) {
    const f = fixture(async () => presence, 'unavailable');
    const done = f.launch.start(); await turn();
    assert.deepEqual(f.order, presence === 'not-detected' ? ['play', 'open'] : ['open']);
    f.opened.resolve('accepted'); await done;
  }
});

test('skipping playback leaves the open request alone; failed/unconfirmed results still report', async () => {
  for (const result of ['failed', 'unconfirmed'] as const) {
    const f = fixture(async () => 'not-detected');
    const done = f.launch.start(); await turn();
    if (result === 'failed') f.played.resolve();
    f.opened.resolve(result); await done;
    assert.deepEqual(f.order, ['play', 'open', 'close', result]);
  }
});

test('quit before lookup settles never opens; quit in flight closes only our video and ignores late result', async () => {
  const lookup = deferred<CodexPresence>();
  const waiting = fixture(() => lookup.promise);
  void waiting.launch.start(); await turn();
  const closing = waiting.launch.dispose();
  lookup.resolve('not-detected'); await closing;
  await waiting.launch.start(); assert.deepEqual(waiting.order, []);
  const f = fixture(async () => 'not-detected');
  void f.launch.start(); await turn();
  const closed = f.launch.dispose();
  assert.deepEqual(f.order, ['play', 'open', 'close']);
  f.opened.resolve('failed'); await closed;
  assert.deepEqual(f.order, ['play', 'open', 'close']);
});

test('launcher uses the fixed bundle target and sanitizes errors and timeouts', async () => {
  assert.equal(await openInstalledCodex(async (file, args, opts) => {
    assert.equal(file, '/usr/bin/open'); assert.deepEqual(args, ['-b', 'com.openai.codex']);
    assert.deepEqual(opts, { shell: false, env: { LC_ALL: 'C' }, timeout: 8000, maxBuffer: 2048, killSignal: 'SIGKILL' });
  }), 'accepted');
  assert.equal(await openInstalledCodex(async () => { throw Object.assign(new Error('synthetic'), { code: 1 }); }), 'failed');
  assert.equal(await openInstalledCodex(async () => { throw Object.assign(new Error('synthetic'), { killed: true }); }), 'unconfirmed');
});

function surface() {
  const timers = new Map<number, () => void>();
  const events: string[] = [];
  const playback = manageStartupPlayback({ show: () => events.push('show'), close: () => events.push('close'),
    schedule: (ms, callback) => { timers.set(ms, callback); return () => { timers.delete(ms); }; } });
  return { events, timers, playback };
}

test('video shows only after playback, ignores unrelated frames, and closes once after completion or skip', async () => {
  const s = surface();
  assert.equal(startupSignal(`${STARTUP_URL}#playing`, false), undefined);
  assert.equal(startupSignal('pet-app://workspace/index.html#playing', true), undefined);
  assert.equal(startupSignal(`${STARTUP_URL}#unexpected`, true), undefined);
  assert.deepEqual(s.events, []);
  s.playback.signal(startupSignal(`${STARTUP_URL}#playing`, true)!);
  assert.deepEqual(s.events, ['show']); assert.deepEqual([...s.timers.keys()], [30_000]);
  assert.equal(startupSignal(`${STARTUP_URL}#finished`, true), 'finished');
  s.playback.signal('finished'); s.playback.signal('skipped'); s.playback.signal('playing');
  await s.playback.done; assert.deepEqual(s.events, ['show', 'close']); assert.equal(s.timers.size, 0);
});

test('loading timeout never flashes a blank window and overall deadline closes a stalled video', async () => {
  const waiting = surface(); waiting.timers.get(8000)!(); await waiting.playback.done;
  waiting.playback.signal('playing'); assert.deepEqual(waiting.events, ['close']); assert.equal(waiting.timers.size, 0);
  const shown = surface(); shown.playback.signal('playing'); shown.timers.get(30_000)!(); await shown.playback.done;
  assert.deepEqual(shown.events, ['show', 'close']); assert.equal(shown.timers.size, 0);
});

test('window alignment starts after the first visible frame and stops before the player closes', async () => {
  for (const end of ['skipped', 'finished', 'failed'] as const) {
    const events: string[] = [];
    const playback = manageStartupPlayback({ show: () => events.push('show'), close: () => events.push('close'),
      startAlignment: () => { events.push('track'); return () => { events.push('stop'); }; } });
    assert.deepEqual(events, []);
    playback.signal('playing'); playback.signal('playing');
    playback.signal(end); playback.close();
    await playback.done;
    assert.deepEqual(events, ['show', 'track', 'stop', 'close']);
  }
});
