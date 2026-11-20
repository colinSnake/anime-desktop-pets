import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkPoseSchedule } from '../src/video-preview/task-schedule.ts';
import { DragSchedule } from '../src/video-preview/drag-schedule.ts';
import { taskAnimationOff } from '../../app-service/src/task-animation.ts';

const wall = 1_000_000;
const working = (startSerial: number, expiresAt = wall + 6000) => ({ state: 'working' as const, startSerial, expiresAt });
const quiet = { blocked: false, reduced: false, showingWork: false, finished: false };
const work = { ...quiet, showingWork: true };

test('work joins without a fake opening, then plays each genuinely new opening only once', () => {
  const poses = new WorkPoseSchedule();
  poses.receive(working(0), wall, 0, false);
  assert.equal(poses.next(0, quiet), 'work02');
  assert.equal(poses.next(3, work), undefined);
  assert.equal(poses.next(4, { ...work, finished: true }), 'work03');
  poses.receive(working(5), wall + 4, 4, false);
  assert.equal(poses.next(4, work), 'work');
  poses.receive(working(5), wall + 5, 5, false);
  assert.equal(poses.next(5, work), undefined);
  assert.equal(poses.next(6, { ...work, finished: true }), 'work04');
});

test('temporary uncertainty retains but cannot renew a monotonic lease; stale/overlong input is never animated', () => {
  const poses = new WorkPoseSchedule();
  poses.receive(working(1, wall + 80), wall, 200, false);
  assert.equal(poses.next(200, quiet), 'work');
  poses.receive({ state: 'unknown', startSerial: 0, expiresAt: 0 }, wall - 500, 240, false);
  assert.equal(poses.active(279), true);
  assert.equal(poses.next(280, work), 'idle');
  for (const invalid of [wall, wall - 1, wall + 6001]) {
    poses.receive(working(2, invalid), wall, 500, false);
    assert.equal(poses.next(500, quiet), undefined);
  }
});

test('expired or revoked work cannot replay after a hidden window, menu or manual pose yields', () => {
  const poses = new WorkPoseSchedule();
  const blocked = { ...quiet, blocked: true };
  poses.receive(working(1, wall + 5), wall, 0, false);
  assert.equal(poses.next(1, blocked), undefined);
  assert.equal(poses.next(6, quiet), undefined);
  poses.receive(working(2), wall, 10, false);
  assert.equal(poses.next(10, blocked), undefined);
  poses.receive(taskAnimationOff, wall + 1, 11, false);
  assert.equal(poses.next(12, blocked), undefined);
  assert.equal(poses.next(13, quiet), undefined);
  poses.receive(working(3), wall, 20, false);
  assert.equal(poses.next(21, blocked), undefined);
  assert.equal(poses.next(22, quiet), 'work');
});

test('reduced motion suppresses task poses and consumes openings without losing a valid lease', () => {
  const poses = new WorkPoseSchedule();
  poses.receive(working(1), wall, 0, true);
  assert.equal(poses.next(1, { ...quiet, reduced: true }), undefined);
  assert.equal(poses.next(2, quiet), 'work02');
  poses.receive(working(2), wall, 3, false);
  assert.equal(poses.next(3, { ...work, blocked: true, reduced: true }), undefined);
  assert.equal(poses.next(4, { ...work, reduced: true }), 'idle');
  assert.equal(poses.next(5, quiet), 'work03');
});

test('a task permits genuine dragging and a release spring; a new task does not change its trajectory or save synthetic drops', () => {
  const poses = new WorkPoseSchedule();
  let point = { x: 200, y: 200 };
  const drops: unknown[] = [];
  const drag = new DragSchedule({ position: () => point, size: () => ({ width: 128, height: 128 }),
    workArea: () => ({ x: 0, y: 0, width: 1600, height: 900 }), move: next => { point = next; },
    show() {}, face() {}, reducedMotion: () => false, onDrop: value => drops.push(value) });
  poses.receive(working(1), wall, 0, false);
  assert.equal(poses.next(0, quiet), 'work');
  drag.setTaskActive(poses.active(1));
  drag.begin(point, 10);
  drag.move({ x: 245, y: 201 }, 40);
  drag.move({ x: 315, y: 225 }, 75);
  assert.equal(drag.blocksAutonomousPlay, true);
  assert.equal(poses.next(75, { ...work, blocked: drag.protectsPlay }), undefined);
  assert.equal(drag.finish(80, true), 'flick');
  poses.receive(working(2), wall + 80, 80, false);
  assert.equal(poses.next(80, { ...quiet, blocked: drag.protectsPlay }), undefined);
  const releasePoint = point;
  drag.tick(96);
  assert.notDeepEqual(point, releasePoint);
  let now = 112;
  for (; drag.protectsPlay && now <= 20_000; now += 16) {
    if (now % 2048 === 112) poses.receive(working(2, wall + now + 6000), wall + now, now, false);
    drag.tick(now);
  }
  assert.equal(drag.protectsPlay, false);
  assert.equal(poses.next(now, { ...quiet, blocked: drag.protectsPlay }), 'work');
  assert.deepEqual(drops, [releasePoint]);
});
