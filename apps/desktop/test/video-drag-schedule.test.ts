import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { DragSchedule, type DragPose, type DragScheduleOptions } from '../src/video-preview/drag-schedule.ts';
import { estimateReleaseVelocity, estimateTerminalReleaseVelocity, ReleaseSpring } from '../src/video-preview/release-physics.ts';

const bounds = { left: -800, top: 0, right: 500, bottom: 500 };
const area = { x: -800, y: 0, width: 1500, height: 700 };
const origin = { x: 70, y: 110 };
const trail = [{ time: 0, x: 40, y: 350 }, { time: 33, x: 85, y: 295 },
  { time: 72, x: 136, y: 221 }, { time: 109, x: 210, y: 90 }];

test('two-axis estimator and spring numerically match the repository Qt reference', () => {
  const python = process.env.PET_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const command = `import json,sys
sys.path.insert(0, 'apps/pet-runtime/bailong')
from pet_release_physics import estimate_release_velocity, ReleaseSpring
s,b=json.load(sys.stdin)
vel=estimate_release_velocity([(p['time']/1000,p['x'],p['y']) for p in s], .115)
r=ReleaseSpring.launch((400,110), vel, (b['left'],b['top'],b['right'],b['bottom']))
rows=[]
for i in range(660):
    if i==250: r.update_bounds((-350,0,400,460))
    r.advance((.016,.033,0,.05)[i%4]); rows.append([r.x,r.y,r.vx,r.vy,r.grounded,r.settled,r.top_bounces,r.bottom_bounces])
print(json.dumps([vel,rows]))`;
  const result = spawnSync(python, ['-I', '-B', '-c', command], { input: JSON.stringify([trail, bounds]), encoding: 'utf8', timeout: 8000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const [velocity, rows] = JSON.parse(result.stdout);
  const actual = estimateReleaseVelocity(trail, 115)!;
  const onlyClose = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
  onlyClose(actual.x, velocity[0]); onlyClose(actual.y, velocity[1]);
  const spring = new ReleaseSpring({ x: 400, y: 110 }, actual, bounds);
  for (const [i, expected] of (rows as unknown[][]).entries()) {
    if (i === 250) spring.setBounds({ left: -350, top: 0, right: 400, bottom: 460 });
    spring.advance([16, 33, 0, 50][i % 4]!);
    [spring.x, spring.y, spring.vx, spring.vy].forEach((value, n) => onlyClose(value, expected[n] as number));
    assert.deepEqual([spring.grounded, spring.settled, spring.topBounces, spring.bottomBounces], expected.slice(4));
  }
  assert.ok(spring.topBounces > 0 && spring.bottomBounces > 0 && spring.settled);
  assert.equal(spring.position().y, 460);
});

function session(options?: DragScheduleOptions, start = origin, workArea = area) {
  let position = start;
  let reduced = false;
  const poses: DragPose[] = [];
  const drops: typeof origin[] = [];
  const faces: string[] = [];
  const drag = new DragSchedule({ position: () => position, size: () => ({ width: 200, height: 200 }), workArea: () => workArea,
    move: point => { position = point; }, show: pose => { poses.push(pose); }, face: face => { if (face) faces.push(face); },
    onDrop: point => { drops.push(point); }, reducedMotion: () => reduced, random: () => 0 }, options);
  return { drag, poses, drops, faces, position: () => position, reduced: () => { reduced = true; } };
}

test('release classification follows the final valid movement segment, not earlier speed', () => {
  const slowThenFlick = [
    { time: 0, x: 100, y: 100 }, { time: 30, x: 109, y: 100 }, { time: 65, x: 110, y: 100 },
    { time: 100, x: 111, y: 100 }, { time: 140, x: 136, y: 100 },
  ];
  const fastThenBrake = [
    { time: 0, x: 100, y: 100 }, { time: 30, x: 128, y: 100 }, { time: 60, x: 155, y: 100 },
    { time: 90, x: 158, y: 100 }, { time: 120, x: 160, y: 100 },
  ];
  assert.ok((estimateTerminalReleaseVelocity(slowThenFlick, 145)?.x ?? 0) >= 280);
  assert.equal(estimateTerminalReleaseVelocity(fastThenBrake, 125), undefined);
  assert.equal(estimateTerminalReleaseVelocity(slowThenFlick, 221), undefined, 'stale releases remain inert');
});

test('idle-bounce release keeps the idle clip while applying the same spring physics', () => {
  const { drag, poses, faces, drops, position, reduced } = session({ releaseMode: 'idle-bounce' });
  drag.setMovement(false); // The companion does not expose an autonomous movement preference.
  const moveAndRelease = (start: number, first: number, second: number) => {
    drag.begin({ x: 100, y: 160 }, start);
    drag.move({ x: 100 + first, y: 160 }, start + 30);
    drag.move({ x: 100 + second, y: 160 }, start + 60);
    return drag.finish(start + 65, true);
  };
  assert.equal(moveAndRelease(0, 10, 24), 'flick');
  const start = position();
  assert.deepEqual(drops, [start]);
  drag.tick(81);
  assert.notDeepEqual(position(), start);
  for (let at = 97; at < 10_000 && drag.isAirborne; at += 16) drag.tick(at);
  assert.equal(drag.needsTick, false, 'an idle-only bounce does not need a settled pose timer');
  assert.equal(moveAndRelease(11_000, 14, 25), 'flick');
  assert.equal(moveAndRelease(12_000, 40, 42), 'drop', 'braking before release does not bounce');
  reduced();
  assert.equal(moveAndRelease(13_000, 30, 60), 'drop');
  assert.deepEqual(poses, [], 'never change the idle animation');
  assert.deepEqual(faces, [], 'idle has no directional rendering');
});

test('companion flick uses only its available rebound and exits the hover loop when rebound media is missing', () => {
  const run = (companionRebound: boolean) => {
    const state = session({ releaseMode: 'companion', companionHover: true, companionRebound });
    state.drag.begin({ x: 100, y: 160 }, 0);
    state.drag.move({ x: 120, y: 160 }, 30);
    state.drag.move({ x: 145, y: 160 }, 60);
    assert.deepEqual(state.poses, ['companion-hover']);
    assert.equal(state.drag.finish(65, true), 'flick');
    return state;
  };

  const withRebound = run(true);
  assert.deepEqual(withRebound.poses, ['companion-hover', 'companion-rebound']);

  const withoutRebound = run(false);
  assert.deepEqual(withoutRebound.poses, ['companion-hover', 'idle']);
  assert.ok(withoutRebound.drag.isAirborne, 'spring physics remains independent of optional animation media');
  withoutRebound.drag.tick(81);
  assert.equal(withoutRebound.poses.at(-1), 'idle', 'the missing clip cannot leave hover looping while the spring moves');
});

test('flick velocity follows the pointer after the pet reaches a screen edge', () => {
  for (const releaseMode of ['companion', 'animation'] as const) {
    let position = { x: 270, y: 110 };
    const poses: DragPose[] = [];
    const drops: { x: number; y: number }[] = [];
    const drag = new DragSchedule({
      position: () => position,
      size: () => ({ width: 200, height: 200 }),
      workArea: () => ({ x: 0, y: 0, width: 500, height: 500 }),
      move: point => { position = point; },
      show: pose => { poses.push(pose); },
      face: () => {},
      onDrop: point => drops.push(point),
      reducedMotion: () => false,
      random: () => 0,
    }, { releaseMode, companionHover: true, companionRebound: true });

    drag.begin({ x: 200, y: 160 }, 0);
    drag.move({ x: 230, y: 160 }, 30);
    drag.move({ x: 260, y: 160 }, 60);
    drag.move({ x: 290, y: 160 }, 90);
    assert.deepEqual(position, { x: 300, y: 110 }, 'the pet stays clamped to the work-area edge');
    assert.equal(drag.finish(100, true, { x: 320, y: 160 }), 'flick');
    assert.deepEqual(drops, [{ x: 300, y: 110 }], 'persist only the clamped release point');
    assert.equal(poses.at(-1), releaseMode === 'companion' ? 'companion-rebound' : 'release-move02');
  }
});

test('companion keeps its current pose on a stationary press or below-threshold pointer movement', () => {
  const { drag, poses, drops } = session({ releaseMode: 'companion', companionHover: true });
  drag.begin({ x: 100, y: 160 }, 0);
  drag.tick(16);
  drag.move({ x: 104, y: 164 }, 25);
  drag.tick(32);
  assert.equal(drag.finish(40, true), 'click');
  assert.deepEqual(poses, []);
  assert.deepEqual(drops, []);
});

test('press threshold, slow drag, and held-fast drag never turn into release animation', () => {
  const { drag, drops, poses, position } = session();
  drag.begin({ x: 100, y: 160 }, 0);
  drag.move({ x: 104, y: 164 }, 25);
  assert.equal(drag.finish(30, true), 'click');
  assert.deepEqual(drops, []);
  assert.equal(poses.length, 0);
  drag.begin({ x: 100, y: 160 }, 100);
  drag.move({ x: 180, y: 160 }, 150);
  assert.equal(poses.at(-1), 'move02');
  drag.tick(231);
  assert.equal(poses.at(-1), 'move02', 'a brief pointer gap does not restart the idle decoder');
  assert.equal(drag.finish(235, true), 'drop');
  assert.equal(poses.at(-1), 'idle', 'a light release returns to idle immediately');
  assert.deepEqual(drops, [{ x: 150, y: 110 }]);
  assert.deepEqual(position(), drops[0]);
  assert.ok(!poses.some(p => p.startsWith('release-')));
});

test('real release records its changed endpoint before computing velocity without requesting a held pose', () => {
  const { drag, poses, drops, position } = session();
  drag.begin({ x: 100, y: 160 }, 0);
  drag.move({ x: 112, y: 160 }, 36);
  const before = poses.length;
  assert.equal(drag.finish(58, true, { x: 159, y: 140 }), 'flick');
  assert.equal(poses.length, before + 1);
  assert.ok(poses.at(-1)?.startsWith('release-'));
  assert.deepEqual(position(), { x: 129, y: 90 });
  assert.deepEqual(drops, [position()]);
  assert.equal(drag.finish(60, true, { x: 165, y: 135 }), undefined);
  assert.equal(drops.length, 1);
});

test('a stale trajectory saves the true endpoint but cannot make a fling, and cancel ignores the endpoint', () => {
  const { drag, drops, position } = session();
  drag.begin({ x: 100, y: 160 }, 0);
  drag.move({ x: 112, y: 160 }, 36);
  assert.equal(drag.finish(116, true, { x: 185, y: 160 }), 'drop');
  assert.deepEqual(drops, [{ x: 155, y: 110 }]);
  assert.equal(drag.isAirborne, false);
  drag.begin({ x: 185, y: 160 }, 200);
  assert.equal(drag.finish(240, false, { x: 250, y: 160 }), 'cancel');
  assert.deepEqual(position(), drops[0]);
  assert.equal(drops.length, 1);
});

test('release-only displacement uses the same drag and speed gates and small movement stays a click', () => {
  const { drag, drops } = session();
  drag.begin({ x: 100, y: 160 }, 0);
  assert.equal(drag.finish(40, true, { x: 104, y: 163 }), 'click');
  assert.deepEqual(drops, []);
  drag.begin({ x: 100, y: 160 }, 100);
  assert.equal(drag.finish(145, true, { x: 118, y: 160 }), 'drop');
  assert.deepEqual(drops, [{ x: 88, y: 110 }]);
});

test('movement classification retains throttle, direction, and reduced-motion neutral pose', () => {
  const { drag, poses, reduced, drops } = session();
  drag.begin({ x: 100, y: 160 }, 0);
  drag.move({ x: 120, y: 160 }, 50);
  assert.equal(poses.at(-1), 'move01right');
  drag.move({ x: 120, y: 120 }, 55);
  assert.equal(poses.at(-1), 'move01right'); // Inside 50ms profile throttle.
  drag.move({ x: 120, y: 40 }, 105);
  assert.equal(poses.at(-1), 'move03right');
  reduced();
  drag.tick(156);
  assert.equal(poses.at(-1), 'idle');
  assert.equal(drag.finish(157, true), 'drop');
  assert.equal(drops.length, 1);
});

test('flick runs without frame callbacks, uses both axes, clamps tick and records only drop', () => {
  const { drag, poses, drops, position, faces } = session();
  drag.setMovement(true);
  drag.setTaskActive(true);
  drag.begin({ x: 100, y: 160 }, 0);
  drag.move({ x: 172, y: 105 }, 70);
  assert.equal(drag.finish(75, true), 'flick');
  assert.equal(poses.at(-1), 'release-move02');
  const before = position();
  drag.tick(200);
  assert.ok(position().x > before.x && position().y < before.y);
  assert.ok(Math.hypot(position().x - before.x, position().y - before.y) < 100);
  const moved = position();
  drag.tick(200);
  assert.deepEqual(position(), moved);
  drag.setMovement(true);
  assert.equal(drag.protectsPlay, true);
  drag.setTaskActive(false);
  let now = 200;
  while (drag.isAirborne && now < 18_000) drag.tick(now += 16);
  assert.equal(drag.isAirborne, false);
  assert.equal(position().y, 500);
  assert.ok(faces.includes('left'));
  assert.deepEqual(drops, [before]);
  assert.equal(poses.at(-1), 'release-move02');
  drag.tick(now + 1999);
  assert.equal(poses.at(-1), 'release-move02');
  drag.tick(now + 2000);
  assert.equal(poses.at(-1), 'idle');
});

test('new left press supersedes a spring; canceled or disabled movement never fakes a drop or flick', () => {
  const { drag, drops, position } = session();
  drag.begin({ x: 100, y: 160 }, 0);
  drag.move({ x: 160, y: 160 }, 55);
  assert.equal(drag.finish(60, true), 'flick');
  drag.tick(88);
  const start = position();
  drag.begin({ x: 160, y: 160 }, 89);
  assert.equal(drag.isAirborne, false);
  drag.tick(115);
  assert.deepEqual(position(), start);
  assert.equal(drag.finish(120, false), 'cancel');
  assert.equal(drops.length, 1);
  drag.setMovement(false);
  drag.begin({ x: 160, y: 160 }, 150);
  drag.move({ x: 215, y: 160 }, 190);
  assert.equal(drag.finish(200, true), 'drop');
  assert.equal(drops.length, 2);
});


test('flick distance follows the pointer at every work-area edge, including a negative desktop', () => {
  for (const offset of [0, -1000]) for (const direction of [
    { x: -1, y: 0 }, { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 },
    { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: -1, y: 1 },
  ]) for (const releaseMode of ['animation', 'companion'] as const) {
    const start = { x: offset + (direction.x > 0 ? 288 : 12), y: offset + (direction.y > 0 ? 288 : 12) };
    const cursor = { x: start.x + 100, y: start.y + 100 };
    const { drag, position, drops, poses } = session({ releaseMode, companionHover: true, companionRebound: true },
      start, { x: offset, y: offset, width: 500, height: 500 });
    drag.begin(cursor, 0);
    drag.move({ x: cursor.x + direction.x * 12, y: cursor.y + direction.y * 12 }, 20);
    drag.move({ x: cursor.x + direction.x * 36, y: cursor.y + direction.y * 36 }, 50);
    const clamped = position();
    assert.equal(drag.finish(55, true), 'flick', `${releaseMode}: ${JSON.stringify({ offset, direction })}`);
    assert.deepEqual(drops, [clamped], 'persist the window point, not the unclamped pointer');
    assert.equal(drag.isAirborne, true);
    assert.match(poses.at(-1)!, releaseMode === 'companion' ? /^companion-rebound$/ : /^release-/);
  }
});

test('slow left and upper-left drags keep their animation across normal gaps between pointer events', () => {
  for (const dy of [0, -3]) {
    const { drag, poses } = session(undefined, { x: 500, y: 400 });
    drag.begin({ x: 600, y: 500 }, 0);
    for (let step = 1; step <= 8; step++) {
      const now = step * 100;
      drag.move({ x: 600 - step * 12, y: 500 + step * dy }, now);
      for (let tick = now + 16; tick < now + 100; tick += 16) drag.tick(tick);
    }
    assert.deepEqual(poses, ['move01left'], 'timer ticks must not alternate walking and idle during one slow drag');
    drag.tick(1050);
    assert.equal(poses.at(-1), 'idle', 'a genuine stop still returns to idle');
    assert.equal(drag.finish(1055, true), 'drop', 'pose smoothing must not revive stale release momentum');
  }
});


test('edge recognition still rejects tiny, slow, braked and held releases in both pet modes', () => {
  const traces = [
    [{ time: 20, distance: 10 }, { time: 40, distance: 20 }],
    [{ time: 200, distance: 20 }, { time: 400, distance: 40 }],
    [{ time: 30, distance: 30 }, { time: 60, distance: 32 }],
    [{ time: 30, distance: 30 }, { time: 60, distance: 60 }],
  ];
  for (const releaseMode of ['animation', 'companion'] as const) for (const direction of [
    { x: -1, y: 0 }, { x: -1, y: -1 }, { x: 1, y: 0 }, { x: 1, y: 1 },
  ]) for (const [index, trace] of traces.entries()) {
    const start = { x: direction.x < 0 ? 0 : 300, y: direction.y < 0 ? 0 : 300 };
    const state = session({ releaseMode, companionHover: true, companionRebound: true }, start,
      { x: 0, y: 0, width: 500, height: 500 });
    const cursor = { x: start.x + 100, y: start.y + 100 };
    state.drag.begin(cursor, 0);
    for (const sample of trace) {
      // Normalize diagonals so the tiny trace is genuinely under 24 logical pixels.
      const distance = sample.distance / Math.hypot(direction.x, direction.y);
      state.drag.move({ x: cursor.x + distance * direction.x, y: cursor.y + distance * direction.y }, sample.time);
    }
    const releaseAt = trace.at(-1)!.time + (index === 3 ? 80 : 5);
    assert.equal(state.drag.finish(releaseAt, true), 'drop', JSON.stringify({ releaseMode, direction, index }));
    assert.equal(state.drag.isAirborne, false);
    assert.equal(state.poses.at(-1), 'idle');
    assert.deepEqual(state.drops, [state.position()]);
  }
});

test('a moving slow drag remains responsive to a sustained speed or direction change', () => {
  const { drag, poses } = session(undefined, { x: 500, y: 400 });
  drag.begin({ x: 600, y: 500 }, 0);
  drag.move({ x: 588, y: 497 }, 100);
  assert.equal(poses.at(-1), 'move01left');
  drag.tick(196); // The transient idle candidate must not block deliberate acceleration.
  drag.move({ x: 500, y: 400 }, 250);
  drag.move({ x: 450, y: 340 }, 300);
  assert.equal(poses.at(-1), 'move03left');
  assert.equal(drag.finish(305, true), 'flick');
  assert.match(poses.at(-1)!, /^release-.*left$/);
});


test('mirrored flicks agree across pet modes, desktop translations and timer interleavings', () => {
  for (const releaseMode of ['animation', 'idle-bounce', 'companion'] as const) {
    for (const offset of [0, -1600]) for (const direction of [-1, 1]) for (const vertical of [0, -1, 1]) {
      const start = { x: offset + 400, y: 400 };
      const cursor = { x: offset + 500, y: 500 };
      const state = session({ releaseMode, companionHover: true, companionRebound: true }, start,
        { x: offset, y: 0, width: 1200, height: 1000 });
      state.drag.setTaskActive(true);
      state.drag.begin(cursor, 0);
      for (let step = 1; step <= 8; step++) {
        const now = step * 10;
        state.drag.move({ x: cursor.x + direction * step * 8, y: cursor.y + vertical * step * 6 }, now);
        state.drag.tick(now + 4);
      }
      const dropped = state.position();
      assert.equal(state.drag.finish(85, true), 'flick', JSON.stringify({ releaseMode, offset, direction, vertical }));
      assert.deepEqual(state.drops, [dropped]);
      state.drag.tick(101);
      assert.ok((state.position().x - dropped.x) * direction > 0);
      if (releaseMode === 'animation') assert.equal(state.poses.at(-1), direction < 0 ? 'release-move02left' : 'release-move02');
      else assert.equal(state.poses.at(-1), releaseMode === 'companion' ? 'companion-rebound' : undefined);
      state.drag.cancel(105);
      assert.equal(state.drag.needsTick, false);
      assert.equal(state.drops.length, 1, 'cancel never persists a second release');
    }
  }
});

test('a slow quantized drag keeps one walking clip across mixed event and timer cadences', () => {
  for (const direction of [-1, 1]) for (const vertical of [0, -0.25]) {
    const state = session(undefined, { x: 500, y: 400 });
    const cursor = { x: 600, y: 500 };
    state.drag.begin(cursor, 0);
    let now = 0;
    for (const gap of [16, 24, 33, 50, 64, 100, 150, 16, 100, 33, 150, 50]) {
      for (let tick = now + 16; tick < now + gap; tick += 16) state.drag.tick(tick);
      now += gap;
      state.drag.move({ x: cursor.x + direction * Math.round(now * .15), y: cursor.y + Math.round(now * .15 * vertical) }, now);
    }
    assert.deepEqual(state.poses, [direction < 0 ? 'move01left' : 'move01right']);
    state.drag.tick(now + 250);
    assert.equal(state.poses.at(-1), 'idle');
    assert.equal(state.drag.finish(now + 255, true), 'drop');
    assert.equal(state.drag.isAirborne, false);
  }
});

test('distance and freshness release boundaries remain independent of pose smoothing', () => {
  for (const releaseMode of ['animation', 'companion'] as const) for (const direction of [-1, 1]) {
    for (const distance of [23, 24]) for (const age of [79, 80]) {
      const state = session({ releaseMode, companionHover: true, companionRebound: true }, { x: 400, y: 400 });
      const cursor = { x: 500, y: 500 };
      state.drag.begin(cursor, 0);
      state.drag.move({ x: cursor.x + direction * distance / 2, y: cursor.y }, 15);
      state.drag.move({ x: cursor.x + direction * distance, y: cursor.y }, 30);
      state.drag.tick(60);
      const expected = distance >= 24 && age < 80 ? 'flick' : 'drop';
      assert.equal(state.drag.finish(30 + age, true), expected, JSON.stringify({ releaseMode, direction, distance, age }));
      assert.equal(state.drag.isAirborne, expected === 'flick');
      assert.equal(state.drops.length, 1);
    }
  }
});

test('reduced motion and cancellation interrupt a pending stop without reviving momentum', () => {
  for (const releaseMode of ['animation', 'companion'] as const) for (const cancel of [false, true]) {
    const state = session({ releaseMode, companionHover: true, companionRebound: true });
    state.drag.begin({ x: 100, y: 160 }, 0);
    state.drag.move({ x: 70, y: 140 }, 40);
    state.drag.tick(125);
    state.reduced();
    state.drag.tick(180);
    assert.equal(state.poses.at(-1), 'idle');
    assert.equal(state.drag.finish(185, !cancel), cancel ? 'cancel' : 'drop');
    assert.equal(state.drag.needsTick, false);
    assert.equal(state.drops.length, cancel ? 0 : 1);
    const poses = [...state.poses];
    for (const now of [200, 500, 5000]) state.drag.tick(now);
    assert.deepEqual(state.poses, poses);
  }
});
