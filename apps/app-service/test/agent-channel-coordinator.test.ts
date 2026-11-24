import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentChannelCoordinator, type AgentChannelContext, type AgentChannelInput } from '../src/agent/channel-coordinator.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const now = 10_000;
const input = (eventID: string, source: AgentChannelInput['source'] = 'chat', petID = 'pet-one'): AgentChannelInput => {
  const base = { petID, eventID, text: '合成输入' };
  return source === 'live' ? { ...base, source, occurredAt: now } : { ...base, source };
};
const unused = () => { assert.fail('rejected events must not execute'); };

test('execution sees only current text, source, owned signal, and an output gate that ends with its turn', async () => {
  const coordinator = new AgentChannelCoordinator();
  let context!: AgentChannelContext;
  const request = input('current');
  const result = await coordinator.run(request, async turn => {
    context = turn;
    assert.deepEqual(Object.keys(turn).sort(), ['isCurrent', 'signal', 'source', 'text']);
    assert.equal(turn.text, request.text);
    assert.equal(turn.source, 'chat');
    assert.equal(turn.signal.aborted, false);
    assert.equal(turn.isCurrent(), true);
    return '合成结果';
  });
  assert.deepEqual(result, { status: 'completed', value: '合成结果' });
  assert.equal(context.isCurrent(), false);
  await coordinator.close();
});

for (const source of ['voice', 'chat'] as const) {
  test(`${source} preempts same-pet live, reserves the slot, and waits for cleanup`, { timeout: 2000 }, async () => {
    const coordinator = new AgentChannelCoordinator({ now: () => now });
    const started = deferred(), cleanup = deferred();
    let old!: AgentChannelContext;
    let manualStarted = false;
    const live = coordinator.run(input('live', 'live'), async turn => {
      old = turn; started.resolve();
      await cleanup.promise;
      assert.equal(turn.isCurrent(), false);
      return '迟到直播';
    });
    await started.promise;
    const manual = coordinator.run(input('manual', source), async turn => {
      manualStarted = true;
      assert.equal(turn.isCurrent(), true);
      return '手动回复';
    });
    assert.equal(old.signal.aborted, true);
    assert.equal(old.isCurrent(), false);
    assert.deepEqual(await live, { status: 'cancelled', reason: 'preempted' });
    assert.deepEqual(await coordinator.run(input('busy-live', 'live'), unused), { status: 'dropped', reason: 'busy' });
    assert.deepEqual(await coordinator.run(input('busy-manual', 'chat'), unused), { status: 'dropped', reason: 'busy' });
    assert.equal(manualStarted, false);
    cleanup.resolve();
    assert.deepEqual(await manual, { status: 'completed', value: '手动回复' });
    await coordinator.close();
  });

  test(`live and other manual inputs cannot preempt active ${source}; dropped IDs never replay`, { timeout: 2000 }, async () => {
    const coordinator = new AgentChannelCoordinator({ now: () => now });
    const started = deferred(), finish = deferred();
    let current!: AgentChannelContext;
    const manual = coordinator.run(input('active', source), async turn => { current = turn; started.resolve(); await finish.promise; });
    await started.promise;
    assert.deepEqual(await coordinator.run(input('drop', 'live'), unused), { status: 'dropped', reason: 'busy' });
    assert.deepEqual(await coordinator.run(input('other-manual', source === 'chat' ? 'voice' : 'chat'), unused), { status: 'dropped', reason: 'busy' });
    assert.equal(current.signal.aborted, false);
    assert.equal(current.isCurrent(), true);
    finish.resolve(); await manual;
    assert.deepEqual(await coordinator.run(input('drop', 'live'), unused), { status: 'dropped', reason: 'duplicate' });
    await coordinator.close();
  });
}

test('different pets have independent slots and event namespaces, even during a preemption', { timeout: 2000 }, async () => {
  const coordinator = new AgentChannelCoordinator({ now: () => now });
  const started = deferred(), cleanup = deferred(), otherStarted = deferred(), otherFinish = deferred();
  let first!: AgentChannelContext, other!: AgentChannelContext;
  const live = coordinator.run(input('shared', 'live'), async turn => { first = turn; started.resolve(); await cleanup.promise; });
  await started.promise;
  const parallel = coordinator.run(input('shared', 'chat', 'pet-two'), async turn => { other = turn; otherStarted.resolve(); await otherFinish.promise; });
  await otherStarted.promise;
  const manual = coordinator.run(input('preempt', 'voice'), async () => 'voice');
  assert.equal(first.signal.aborted, true);
  assert.equal(other.signal.aborted, false);
  assert.equal(other.isCurrent(), true);
  cleanup.resolve(); await live; await manual;
  assert.equal(other.isCurrent(), true);
  otherFinish.resolve(); await parallel;
  await coordinator.close();
});

test('manual sources share duplicate keys in flight and after failure; live uses its own namespace', { timeout: 2000 }, async () => {
  const coordinator = new AgentChannelCoordinator({ now: () => now });
  const started = deferred(), finish = deferred();
  const chat = coordinator.run(input('same'), async () => { started.resolve(); await finish.promise; throw Error('private error'); });
  await started.promise;
  assert.deepEqual(await coordinator.run(input('same', 'voice'), unused), { status: 'dropped', reason: 'duplicate' });
  finish.resolve();
  assert.deepEqual(await chat, { status: 'failed' });
  assert.deepEqual(await coordinator.run(input('same'), unused), { status: 'dropped', reason: 'duplicate' });
  assert.deepEqual(await coordinator.run(input('same', 'live'), async () => 'ok'), { status: 'completed', value: 'ok' });
  await coordinator.close();
});

test('event deduplication fails closed at capacity and never evicts old IDs', async () => {
  const coordinator = new AgentChannelCoordinator({ maxEvents: 2 });
  for (const eventID of ['one', 'two']) assert.equal((await coordinator.run(input(eventID), async () => 'ok')).status, 'completed');
  for (let i = 0; i < 12; i++) {
    assert.deepEqual(await coordinator.run(input(`overflow-${i}`), unused), { status: 'rejected', reason: 'event-capacity' });
    assert.deepEqual(await coordinator.run(input('one'), unused), { status: 'dropped', reason: 'duplicate' });
  }
  await coordinator.close();
});

test('active capacity cannot trigger cross-pet preemption', { timeout: 2000 }, async () => {
  const coordinator = new AgentChannelCoordinator({ maxActive: 1, now: () => now });
  const started = deferred(), finish = deferred();
  let current!: AgentChannelContext;
  const live = coordinator.run(input('live', 'live'), async turn => { current = turn; started.resolve(); await finish.promise; });
  await started.promise;
  assert.deepEqual(await coordinator.run(input('full', 'voice', 'pet-two'), unused), { status: 'rejected', reason: 'active-capacity' });
  assert.equal(current.signal.aborted, false);
  finish.resolve(); await live;
  assert.equal((await coordinator.run(input('fresh', 'chat', 'pet-two'), async () => 'ok')).status, 'completed');
  await coordinator.close();
});

test('text is bounded in UTF-8 and invalid fields cannot reach execution', async () => {
  const coordinator = new AgentChannelCoordinator({ maxTextBytes: 6, now: () => now });
  for (const source of ['chat', 'voice', 'live'] as const) {
    for (const text of ['', '   ', '\u0000', '\ud800', '猫猫!', 'a'.repeat(7)]) {
      assert.deepEqual(await coordinator.run({ ...input('bad', source), text }, unused), { status: 'rejected', reason: 'invalid' });
    }
  }
  for (const patch of [{ petID: '../escape' }, { eventID: '' }, { eventID: 'x'.repeat(129) }, { source: 'task' }, { text: 42 }]) {
    assert.deepEqual(await coordinator.run({ ...input('bad'), text: 'ok', ...patch } as AgentChannelInput, unused), { status: 'rejected', reason: 'invalid' });
  }
  assert.deepEqual(await coordinator.run({ ...input('boundary'), text: '猫猫' }, async turn => turn.text), { status: 'completed', value: '猫猫' });
  await coordinator.close();
});

test('live requires a finite timestamp; stale/future events are dropped even if expiry is reached before execution', async () => {
  let clock = now;
  const coordinator = new AgentChannelCoordinator({ maxLiveAgeMs: 100, now: () => clock });
  for (const occurredAt of [undefined, NaN, Infinity, -1]) {
    assert.deepEqual(await coordinator.run({ ...input('invalid-time', 'live'), source: 'live', occurredAt } as AgentChannelInput, unused), { status: 'rejected', reason: 'invalid' });
  }
  for (const [eventID, occurredAt] of [['old', now - 100], ['future', now + 1]] as const) {
    assert.deepEqual(await coordinator.run({ ...input(eventID, 'live'), source: 'live', occurredAt }, unused), { status: 'dropped', reason: 'stale' });
  }
  const late = coordinator.run(input('expires-before-dispatch', 'live'), unused);
  clock += 100;
  assert.deepEqual(await late, { status: 'dropped', reason: 'stale' });
  await coordinator.close();
});

test('pre-aborted input does not interrupt live, and external cancellation blocks late output through cleanup', { timeout: 2000 }, async () => {
  const coordinator = new AgentChannelCoordinator({ now: () => now });
  const cancellation = new AbortController(), started = deferred(), cleanup = deferred();
  const outputs: string[] = [];
  let current!: AgentChannelContext;
  const live = coordinator.run(input('live', 'live'), async turn => {
    current = turn; started.resolve();
    await cleanup.promise;
    if (turn.isCurrent()) outputs.push('late');
    return 'late';
  }, cancellation.signal);
  await started.promise;
  const stopped = new AbortController(); stopped.abort();
  assert.deepEqual(await coordinator.run(input('stopped', 'voice'), unused, stopped.signal), { status: 'cancelled', reason: 'cancelled' });
  assert.equal(current.signal.aborted, false);
  cancellation.abort();
  assert.equal(current.signal.aborted, true);
  assert.equal(current.isCurrent(), false);
  assert.deepEqual(await live, { status: 'cancelled', reason: 'cancelled' });
  assert.deepEqual(await coordinator.run(input('held', 'live'), unused), { status: 'dropped', reason: 'busy' });
  cleanup.resolve(); await coordinator.close();
  assert.deepEqual(outputs, []);
});

test('cancelled pending manual holds the cleanup barrier and never starts after its predecessor', { timeout: 2000 }, async () => {
  const coordinator = new AgentChannelCoordinator({ now: () => now });
  const started = deferred(), cleanup = deferred(), cancellation = new AbortController();
  const live = coordinator.run(input('live', 'live'), async () => { started.resolve(); await cleanup.promise; });
  await started.promise;
  const manual = coordinator.run(input('manual', 'voice'), unused, cancellation.signal);
  cancellation.abort();
  assert.deepEqual(await manual, { status: 'cancelled', reason: 'cancelled' });
  assert.deepEqual(await coordinator.run(input('too-early', 'voice'), unused), { status: 'dropped', reason: 'busy' });
  cleanup.resolve(); await live; await coordinator.close();
});

test('close rejects new input, cancels all owned turns and waits for all cleanup, idempotently', { timeout: 2000 }, async () => {
  const coordinator = new AgentChannelCoordinator({ now: () => now });
  const firstStarted = deferred(), otherStarted = deferred(), cleanup = deferred(), otherCleanup = deferred();
  const contexts: AgentChannelContext[] = [];
  const live = coordinator.run(input('live', 'live'), async turn => { contexts.push(turn); firstStarted.resolve(); await cleanup.promise; });
  await firstStarted.promise;
  const manual = coordinator.run(input('waiting', 'voice'), unused);
  const parallel = coordinator.run(input('parallel', 'chat', 'pet-two'), async turn => { contexts.push(turn); otherStarted.resolve(); await otherCleanup.promise; });
  await otherStarted.promise;
  let closed = false;
  const closing = coordinator.close();
  void closing.then(() => { closed = true; });
  assert.equal(coordinator.close(), closing);
  assert.deepEqual(await coordinator.run(input('after-close'), unused), { status: 'rejected', reason: 'closed' });
  assert.ok(contexts.every(turn => turn.signal.aborted && !turn.isCurrent()));
  assert.deepEqual(await manual, { status: 'cancelled', reason: 'closed' });
  assert.deepEqual(await parallel, { status: 'cancelled', reason: 'closed' });
  assert.equal(closed, false);
  cleanup.resolve(); await live;
  await Promise.resolve(); assert.equal(closed, false);
  otherCleanup.resolve(); await closing;
  assert.equal(closed, true);
});

test('admission snapshots input before awaiting cleanup', { timeout: 2000 }, async () => {
  const coordinator = new AgentChannelCoordinator({ now: () => now });
  const started = deferred(), cleanup = deferred();
  const live = coordinator.run(input('live', 'live'), async () => { started.resolve(); await cleanup.promise; });
  await started.promise;
  const request = input('manual', 'voice');
  const manual = coordinator.run(request, async turn => { assert.equal(turn.source, 'voice'); return turn.text; });
  Object.assign(request, { source: 'live', text: 'mutated', petID: 'pet-two' });
  cleanup.resolve(); await live;
  assert.deepEqual(await manual, { status: 'completed', value: '合成输入' });
  await coordinator.close();
});

test('live has its own bounded dedupe/rate budget and cannot poison manual admission', async () => {
  let clock = now, starts = 0;
  const coordinator = new AgentChannelCoordinator({ now: () => clock, elapsedNow: () => clock, maxEvents: 2, maxLiveEvents: 3, maxLiveStartsPerMinute: 1 });
  const execute = () => ++starts;
  const live = (id: string, occurredAt = clock): AgentChannelInput => ({ ...input(id, 'live'), source: 'live', occurredAt });
  assert.equal((await coordinator.run(live('shared'), execute)).status, 'completed');
  assert.deepEqual(await coordinator.run(live('shared'), unused), { status: 'dropped', reason: 'duplicate' });
  assert.deepEqual(await coordinator.run(live('two'), unused), { status: 'dropped', reason: 'rate-limited' });
  assert.deepEqual(await coordinator.run(live('three'), unused), { status: 'dropped', reason: 'rate-limited' });
  assert.deepEqual(await coordinator.run(live('overflow'), unused), { status: 'rejected', reason: 'event-capacity' });
  assert.equal((await coordinator.run(input('shared'), execute)).status, 'completed');
  assert.equal((await coordinator.run(input('manual', 'voice'), execute)).status, 'completed');
  clock += 60_000;
  assert.deepEqual(await coordinator.run(live('shared', now), unused), { status: 'dropped', reason: 'stale' });
  assert.equal((await coordinator.run(live('new-minute'), execute)).status, 'completed');
  assert.equal(starts, 4);
});

test('live windows recover for long streams and count only actual starts across pets', async () => {
  let clock = now;
  const coordinator = new AgentChannelCoordinator({ now: () => clock, elapsedNow: () => clock, maxLiveEvents: 1, maxLiveStartsPerMinute: 1 });
  for (let minute = 0; minute < 90; minute++) {
    const live: AgentChannelInput = { ...input(`live-${minute}`, 'live', 'pet-two'), source: 'live', occurredAt: clock };
    assert.equal((await coordinator.run(live, () => 'ok')).status, 'completed');
    clock += 60_000;
  }
  assert.equal((await coordinator.run(input('manual'), () => true)).status, 'completed');
});

test('busy or pre-aborted events do not consume live quota, started work consumes it across pets', async () => {
  const coordinator = new AgentChannelCoordinator({ now: () => now, maxLiveStartsPerMinute: 1 });
  const ready = deferred(), finish = deferred();
  const manual = coordinator.run(input('manual'), async () => { ready.resolve(); await finish.promise; });
  await ready.promise;
  assert.deepEqual(await coordinator.run(input('busy', 'live'), unused), { status: 'dropped', reason: 'busy' });
  const aborted = new AbortController(); aborted.abort();
  assert.deepEqual(await coordinator.run(input('cancelled', 'live', 'pet-two'), unused, aborted.signal), { status: 'cancelled', reason: 'cancelled' });
  assert.deepEqual(await coordinator.run(input('attempted', 'live', 'pet-two'), () => { throw Error('synthetic'); }), { status: 'failed' });
  finish.resolve(); await manual;
  assert.deepEqual(await coordinator.run(input('quota-used', 'live'), unused), { status: 'dropped', reason: 'rate-limited' });
  assert.equal((await coordinator.run(input('voice', 'voice'), () => 'ok')).status, 'completed');
});

test('wall-clock corrections cannot expire quotas early or leave a live slot blocked', async () => {
  let clock = now, elapsed = 0;
  const coordinator = new AgentChannelCoordinator({ now: () => clock, elapsedNow: () => elapsed, maxLiveStartsPerMinute: 1 });
  const live = (id: string): AgentChannelInput => ({ ...input(id, 'live'), source: 'live', occurredAt: clock });
  assert.equal((await coordinator.run(live('first'), () => 'ok')).status, 'completed');
  clock += 3600_000;
  assert.deepEqual(await coordinator.run(live('wall-forward'), unused), { status: 'dropped', reason: 'rate-limited' });
  clock = now - 1000; elapsed += 60_000;
  assert.equal((await coordinator.run(live('wall-back'), () => 'ok')).status, 'completed');
});

test('stale reconnect backlog and already-cancelled messages cannot fill the live receipt table', async () => {
  const coordinator = new AgentChannelCoordinator({ now: () => now, maxLiveEvents: 1, maxLiveAgeMs: 1000 });
  const cancelled = new AbortController(); cancelled.abort();
  assert.deepEqual(await coordinator.run(input('cancelled', 'live'), unused, cancelled.signal), { status: 'cancelled', reason: 'cancelled' });
  for (let index = 0; index < 5; index++) {
    const live: AgentChannelInput = { ...input(`stale-${index}`, 'live'), source: 'live', occurredAt: 0 };
    assert.deepEqual(await coordinator.run(live, unused), { status: 'dropped', reason: 'stale' });
  }
  assert.equal((await coordinator.run(input('fresh', 'live'), () => true)).status, 'completed');
});
