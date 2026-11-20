import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { DragSchedule, type DragPose } from '../src/video-preview/drag-schedule.ts';
import { estimateReleaseVelocity, ReleaseSpring } from '../src/video-preview/release-physics.ts';

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

function session() {
  let position = origin;
  let reduced = false;
  const poses: DragPose[] = [];
  const drops: typeof origin[] = [];
  const faces: string[] = [];
  const drag = new DragSchedule({ position: () => position, size: () => ({ width: 200, height: 200 }), workArea: () => area,
    move: point => { position = point; }, show: pose => { poses.push(pose); }, face: face => { if (face) faces.push(face); },
    onDrop: point => { drops.push(point); }, reducedMotion: () => reduced, random: () => 0 });
  return { drag, poses, drops, faces, position: () => position, reduced: () => { reduced = true; } };
}

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
  assert.equal(poses.at(-1), 'idle');
  assert.equal(drag.finish(235, true), 'drop');
  assert.deepEqual(drops, [{ x: 150, y: 110 }]);
  assert.deepEqual(position(), drops[0]);
  assert.ok(!poses.some(p => p.startsWith('release-')));
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
