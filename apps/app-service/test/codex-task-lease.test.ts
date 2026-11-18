import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexTaskLease } from '../src/codex-task-lease.ts';

const working = { state: 'working', activeCount: 2, startSerial: 9 } as const;
const unknown = { state: 'unknown', activeCount: 0, startSerial: 0 } as const;
const running = async () => 'running' as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  let now = 0, allowed = true;
  const timers = new Map<() => void, number>();
  const lease = new CodexTaskLease({ canFollow: () => allowed, now: () => now, schedule: (callback, ms) => {
    timers.set(callback, now + ms);
    return () => { timers.delete(callback); };
  } });
  return { lease, timers, moveClock(ms: number, executeTimers = true) {
    now += ms;
    if (executeTimers) for (const [fire, deadline] of timers) {
      if (deadline <= now) { timers.delete(fire); fire(); }
    }
  }, deny() { allowed = false; } };
}

const neverRead = async () => assert.fail('no read without fresh permission');

test('following defaults off and explicit opt-in alone cannot authorize reading', async () => {
  const { lease, deny } = fixture();
  assert.equal(await lease.refresh(neverRead), false);
  assert.equal(await lease.sample(neverRead), undefined);
  assert.equal(lease.enable(), true);
  assert.equal(await lease.sample(neverRead), undefined);
  assert.equal(await lease.refresh(running), true);
  assert.deepEqual(await lease.sample(async () => working), working);
  deny();
  assert.equal(lease.enable(), false);
  assert.equal(await lease.sample(neverRead), undefined);
  assert.equal(await lease.refresh(neverRead), false);
});

test('heartbeat renews the same permit, absence or uncertainty cancels it immediately', async () => {
  for (const lose of [async () => 'not-detected' as const, async () => 'unknown' as const, async () => { throw Error('synthetic'); }]) {
    const { lease, timers, moveClock } = fixture();
    assert.ok(lease.enable());
    assert.ok(await lease.refresh(running));
    const read = deferred<typeof working>();
    let permit!: AbortSignal;
    const pending = lease.sample(signal => { permit = signal; return read.promise; });
    moveClock(2000);
    assert.ok(await lease.refresh(running));
    assert.equal(timers.size, 1);
    moveClock(8000);
    assert.equal(permit.aborted, false);
    assert.equal(await lease.refresh(lose), false);
    assert.equal(permit.aborted, true);
    assert.equal(timers.size, 0);
    read.resolve(working);
    assert.equal(await pending, undefined);
    assert.equal(await lease.sample(neverRead), undefined);
    assert.ok(await lease.refresh(running));
    assert.deepEqual(await lease.sample(async () => working), working);
  }
});

test('expiry aborts a read promptly and a delayed timer cannot admit a stale result', async () => {
  for (const timersRan of [true, false]) {
    const { lease, timers, moveClock } = fixture();
    lease.enable(); await lease.refresh(running);
    const read = deferred<typeof working>();
    let signal!: AbortSignal;
    const pending = lease.sample(current => { signal = current; return read.promise; });
    moveClock(9999, timersRan);
    assert.equal(signal.aborted, false);
    moveClock(1, timersRan);
    if (timersRan) {
      assert.equal(signal.aborted, true);
      assert.equal(await pending, undefined);
    }
    read.resolve(working);
    assert.equal(await pending, undefined);
    assert.equal(await lease.sample(neverRead), undefined);
    assert.equal(signal.aborted, true);
    assert.equal(timers.size, 0);
  }
});

test('an early expiry callback rearms the deadline instead of stranding an active read', async () => {
  const { lease, timers, moveClock } = fixture();
  lease.enable(); await lease.refresh(running);
  const read = deferred<typeof working>();
  let signal!: AbortSignal;
  const pending = lease.sample(current => { signal = current; return read.promise; });
  moveClock(9999);
  const early = timers.keys().next().value!;
  timers.delete(early); early();
  assert.equal(signal.aborted, false);
  assert.equal(timers.size, 1);
  moveClock(1);
  assert.equal(signal.aborted, true);
  assert.equal(await pending, undefined);
  read.resolve(working);
});

test('a stale presence lookup cannot authorize a re-enabled or expired session', async () => {
  const { lease, moveClock } = fixture();
  for (const revoke of [() => { lease.disable(); lease.enable(); }, () => moveClock(10_000)]) {
    lease.enable();
    const probe = deferred<'running'>();
    const pending = lease.refresh(() => probe.promise);
    revoke();
    assert.equal(await lease.refresh(neverRead), false);
    probe.resolve('running');
    assert.equal(await pending, false);
    assert.equal(await lease.sample(neverRead), undefined);
  }
  assert.ok(await lease.refresh(running));
});

test('cancellation does not start a second reader until the first has actually settled', async () => {
  const { lease } = fixture();
  lease.enable(); await lease.refresh(running);
  const read = deferred<typeof working>();
  const previous = lease.sample(() => read.promise);
  assert.equal(await lease.sample(neverRead), undefined);
  lease.disable();
  assert.equal(await previous, undefined);
  lease.enable(); await lease.refresh(running);
  assert.equal(await lease.sample(neverRead), undefined);
  read.resolve(working);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await lease.sample(async () => working), working);
});

test('reader output is projected into bounded task states and unreadable is not idle', async () => {
  const { lease } = fixture();
  lease.enable(); await lease.refresh(running);
  const idle = { state: 'idle', activeCount: 0, startSerial: 0 } as const;
  assert.deepEqual(await lease.sample(async () => idle), idle);
  assert.deepEqual(await lease.sample(async () => { throw Error('synthetic read failure'); }), unknown);
  for (const variant of [null, { ...working, activeCount: 0 }, { ...working, activeCount: 4097 },
    { ...working, startSerial: Infinity }, { ...working, state: 'completed' }, { ...working, transcript: 'synthetic' },
    { ...idle, startSerial: 1 }, { ...unknown, activeCount: 1 }]) {
    assert.deepEqual(await lease.sample(async () => variant), unknown);
  }
  const maximum = { ...working, activeCount: 4096, startSerial: 0 };
  const result = await lease.sample(async () => maximum);
  assert.deepEqual(result, maximum);
  assert.notEqual(result, maximum);
});
