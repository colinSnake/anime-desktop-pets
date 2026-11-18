import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexTaskLease, type TaskSnapshot, type TaskPresence } from '../src/codex-task-lease.ts';
import { CodexTaskFollowing } from '../src/codex-task-following.ts';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const lease = new CodexTaskLease({ canFollow: () => true });
  const states: string[] = [];
  const poses: (TaskSnapshot | undefined)[] = [];
  const jobs = new Set<() => void>();
  let presence: TaskPresence = 'not-detected';
  let reads = 0, probes = 0, closes = 0;
  let read = async (_signal: AbortSignal): Promise<unknown> => ({ state: 'working', activeCount: 1, startSerial: 1 });
  const following = new CodexTaskFollowing({ lease, probe: async () => { probes++; return presence; }, changed: value => states.push(value), pose: value => poses.push(value),
    read: signal => { reads++; return read(signal); }, closeReader: async () => { closes++; },
    schedule: callback => { jobs.add(callback); return () => { jobs.delete(callback); }; } });
  return { following, states, poses, jobs, stats: () => ({ reads, probes, closes }), setPresence: (value: TaskPresence) => { presence = value; },
    setRead: (value: typeof read) => { read = value; }, tick: async () => {
      assert.equal(jobs.size, 1); const run = jobs.values().next().value!; jobs.delete(run); run(); await turn();
    } };
}

test('opt-in schedules only trusted presence until running; stop closes the source and clears status', async () => {
  const f = fixture();
  await turn();
  assert.deepEqual(f.stats(), { probes: 0, reads: 0, closes: 0 });
  f.following.setEnabled(true); await turn();
  assert.equal(f.states.at(-1), 'waiting');
  assert.equal(f.stats().reads, 0);
  f.setPresence('running'); await f.tick();
  assert.equal(f.states.at(-1), 'working');
  assert.equal(f.stats().reads, 1);
  assert.equal(f.poses.at(-1)?.startSerial, 1);
  await f.tick();
  assert.equal(f.poses.filter(pose => pose?.state === 'working').length, 2); // Heartbeats renew animation even when the menu is unchanged.
  f.setPresence('unknown'); await f.tick();
  assert.equal(f.states.at(-1), 'unknown');
  assert.ok(f.stats().closes >= 1);
  assert.equal(f.poses.at(-1), undefined);
  f.following.setEnabled(false);
  assert.equal(f.states.at(-1), 'off');
  assert.equal(f.jobs.size, 0);
  await f.following.close();
});

test('disable cancels in-flight sampling; its late snapshot cannot overwrite the next native state', async () => {
  const f = fixture(); f.setPresence('running');
  let permit!: AbortSignal, deliver!: (value: unknown) => void;
  f.setRead(signal => { permit = signal; return new Promise(resolve => { deliver = resolve; }); });
  f.following.setEnabled(true); await turn();
  f.following.setEnabled(false);
  assert.equal(permit.aborted, true);
  f.setPresence('not-detected'); f.following.setEnabled(true);
  deliver({ state: 'working', activeCount: 1, startSerial: 1 }); await turn();
  assert.equal(f.states.at(-1), 'waiting');
  assert.ok(!f.states.includes('working'));
  assert.ok(!f.poses.some(pose => pose?.state === 'working'));
  await f.following.close();
  assert.equal(f.states.at(-1), 'off');
});
