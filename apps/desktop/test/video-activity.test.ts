import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActivitySchedule, activityIdles, activityVariants, planTravel, travelPosition } from '../src/video-preview/activity-schedule.ts';
import { movements, moveFacing, travelRanges } from '../src/video-preview/locomotion.ts';
import { clipSource, loops } from '../src/video-preview/playback.ts';

const prefs = { scheduledActivity: true, movement: false };
const gate = { visible: true, reduced: false, task: false, interaction: false, pointerNearby: false, ready: true };
const origin = { x: -600, y: 400 }, size = { width: 256, height: 256 };
const area = { x: -1280, y: 0, width: 1280, height: 800 };
const geometry = { origin, size, area };

test('normal cadence shuffles every interaction and idle action before repeating its category', () => {
  const schedule = new ActivitySchedule(0, prefs, () => 0);
  assert.equal(schedule.next(19_999, gate, geometry), undefined);
  const clips = Array.from({ length: 45 }, (_, i) => schedule.next(20_000 * (i + 1), gate, geometry)?.clip);
  assert.ok(clips.every((clip, index) => clip && (index % 3 === 2 ? /^idle/.test(clipSource(clip).file) : /^\d\d$/.test(clip))));
  assert.deepEqual(new Set(clips.filter((_, i) => i % 3 !== 2).slice(0, 15)), new Set(activityVariants));
  assert.deepEqual(new Set(clips.filter((_, i) => i % 3 === 2).slice(0, 6)), new Set(activityIdles));
  for (const clip of activityIdles) assert.equal(loops(clip), false);
  assert.equal(loops('idle'), true);
  assert.equal(clipSource('once-idle2').file, 'idle2');
});

test('recent interaction reverses cadence, increases delay; identical preferences do not reset the clock', () => {
  const schedule = new ActivitySchedule(0, prefs, () => 0);
  schedule.userActivity(1_000);
  assert.equal(schedule.setPreferences(20_000, prefs), false);
  assert.equal(schedule.next(36_999, gate, geometry), undefined);
  const clips = [37_000, 73_000, 109_000].map(now => schedule.next(now, gate, geometry)!.clip);
  assert.ok(activityIdles.some(id => id === clips[0]));
  assert.ok(activityIdles.some(id => id === clips[1]));
  assert.ok(activityVariants.some(id => id === clips[2]));
  assert.notEqual(clips[0], clips[1]);
});

test('each gate defers work rather than catching up, and movement cannot bypass disabled activity', () => {
  for (const patch of [{ visible: false }, { reduced: true }, { task: true }, { interaction: true }, { pointerNearby: true }, { ready: false }]) {
    const schedule = new ActivitySchedule(0, { ...prefs, movement: true }, () => 0);
    assert.equal(schedule.next(20_000, { ...gate, ...patch }, geometry), undefined);
    assert.equal(schedule.next(20_100, gate, geometry), undefined);
    assert.equal(schedule.next(40_000, gate, geometry)?.kind, 'travel');
  }
  const schedule = new ActivitySchedule(0, { scheduledActivity: false, movement: true }, () => 0);
  assert.equal(schedule.next(30_000, gate, geometry), undefined);
  assert.equal(schedule.setPreferences(31_000, prefs), true);
  assert.equal(schedule.next(50_999, gate, geometry), undefined);
  assert.equal(schedule.next(51_000, gate, geometry)?.kind, 'pose');
});

test('six one-shot movements use the authored media interval, appropriate direction, caps and top clearance', () => {
  for (const move of movements) {
    const plan = planTravel(move, geometry)!;
    const [start, stop] = travelRanges[move];
    const end = travelPosition(plan, stop);
    const mid = travelPosition(plan, (start + stop) / 2);
    const signed = moveFacing(move) === 'left' ? -1 : 1;
    const cap = move.startsWith('move03') ? 435 : move.startsWith('move02') ? 346 : 230;
    const delta = signed * Math.min(cap, signed === 1 ? 344 : 680);
    assert.equal(loops(plan.clip), false);
    assert.equal(clipSource(plan.clip).range, undefined);
    assert.deepEqual(travelPosition(plan, start - 1), origin);
    assert.deepEqual(end, { x: origin.x + delta, y: origin.y });
    assert.deepEqual(travelPosition(plan, stop + 300), end);
    assert.equal(mid.x, Math.round(origin.x + delta / 2));
    assert.equal(mid.y, move.startsWith('move03') ? 224 : origin.y);
  }
  const atEdge = { ...geometry, origin: { x: area.x + 11, y: area.y } };
  assert.equal(planTravel('move03left', atEdge), undefined);
  const schedule = new ActivitySchedule(0, { ...prefs, movement: true }, () => 0);
  const right = schedule.next(20_000, gate, atEdge)!;
  assert.equal(right.kind, 'travel');
  assert.equal(right.clip, 'full-move02');
  assert.notEqual(schedule.next(40_000, gate, atEdge)?.clip, right.clip);
  assert.equal(schedule.next(60_000, gate, { ...atEdge, size: area, origin: area })?.kind, 'pose');
});
