import { clampPosition, type Point, type Sample, type Size } from './motion';
import { moveFacing, movements, releases, type Facing, type Movement, type ReleasePose } from './locomotion';
import { estimateReleaseVelocity, ReleaseSpring, type Edges } from './release-physics';

export type DragPose = 'idle' | Movement | ReleasePose;
export type DragEnd = 'click' | 'drop' | 'flick' | 'cancel';
interface DragPort {
  position(): Point;
  size(): Size;
  workArea(point: Point): Point & Size;
  move(position: Point): void;
  show(pose: DragPose): void;
  face(direction: Facing | undefined): void;
  onDrop?(position: Point): void;
  reducedMotion(): boolean;
  random?(): number;
}

type Press = { cursor: Point; origin: Point; lastCursor: Point; active: boolean; trail: Sample[]; maxDistance: number;
  pose?: DragPose; profileAt: number; started: number };

function heldVelocity(now: number, trail: readonly Sample[]): Point {
  const samples = trail.filter(p => now - p.time >= 0 && now - p.time <= 200);
  const first = samples[0], last = samples.at(-1);
  if (!first || !last || last.time - first.time < 8 || now - last.time >= 80) return { x: 0, y: 0 };
  const span = last.time - first.time;
  const weights = samples.map(p => .5 + (p.time - first.time) / span);
  const total = weights.reduce((a, b) => a + b, 0);
  const mean = (v: (p: Sample) => number) => samples.reduce((sum, p, i) => sum + weights[i]! * v(p), 0) / total;
  const midTime = mean(p => (p.time - first.time) / 1000);
  const centered = (p: Sample) => (p.time - first.time) / 1000 - midTime;
  const variance = mean(p => centered(p) ** 2);
  if (variance * total <= 1e-12) return { x: 0, y: 0 };
  const decay = Math.exp(-4 * (now - last.time) / 1000);
  const slope = (axis: 'x' | 'y') => {
    const mid = mean(p => p[axis]);
    return mean(p => centered(p) * (p[axis] - mid)) / variance * decay;
  };
  return { x: slope('x'), y: slope('y') };
}

/** Coordinates/monotonic ms come only from the host. A pose acknowledgement never advances physics. */
export class DragSchedule {
  private press?: Press;
  private flight?: { spring: ReleaseSpring; last: number; displayPoint: Point; facing: Facing };
  private holdUntil?: number;
  private facing: Facing = 'right';
  private movement = true;
  private taskActive = false;

  constructor(private readonly port: DragPort) {}
  get pressed() { return !!this.press; }
  get isAirborne() { return !!this.flight; }
  get protectsPlay() { return !!(this.press || this.flight); }
  get blocksAutonomousPlay() { return this.protectsPlay || this.taskActive; }
  get needsTick() { return this.protectsPlay || this.holdUntil !== undefined; }
  get pressedAt() { return this.press?.started; }

  setTaskActive(value: boolean) { this.taskActive = value; }
  setMovement(value: boolean) {
    if (this.movement === value) return;
    this.movement = value;
    this.clearFlight();
  }

  private clearFlight() {
    if (!this.flight && this.holdUntil === undefined) return;
    this.flight = undefined;
    this.holdUntil = undefined;
    this.port.face(undefined);
    this.port.show('idle');
  }
  // For an explicit external action, after checking protectsPlay, so a held (settled) pose can yield.
  yieldSettledPose() {
    if (this.protectsPlay) return false;
    if (this.holdUntil !== undefined) {
      this.holdUntil = undefined;
      this.port.face(undefined);
    }
    return true;
  }

  begin(cursor: Point, now: number) {
    if (this.press) return;
    this.clearFlight();
    const origin = this.port.position();
    this.press = { cursor, lastCursor: cursor, origin, active: false, trail: [{ ...origin, time: now }],
      maxDistance: 0, started: now, profileAt: -Infinity };
  }

  move(cursor: Point, now: number) {
    const press = this.press;
    if (!press || (cursor.x === press.lastCursor.x && cursor.y === press.lastCursor.y)) return;
    press.lastCursor = cursor;
    const dx = cursor.x - press.cursor.x, dy = cursor.y - press.cursor.y;
    if (!press.active && Math.abs(dx) + Math.abs(dy) <= 8) return;
    press.active = true;
    const position = clampPosition({ x: press.origin.x + dx, y: press.origin.y + dy }, this.port.size(), this.port.workArea(cursor));
    this.port.move(position);
    press.trail.push({ ...position, time: now });
    if (press.trail.length > 64) press.trail.shift();
    press.maxDistance = Math.max(press.maxDistance, Math.hypot(position.x - press.origin.x, position.y - press.origin.y));
    this.updateDrag(press, now);
  }

  private updateDrag(press: Press, now: number) {
    if (!press.active || now - press.profileAt < 50) return;
    press.profileAt = now;
    const { x, y } = heldVelocity(now, press.trail);
    const speed = Math.hypot(x, y);
    const previous = press.pose ?? 'idle';
    let pose: 'idle' | Movement = 'idle';
    if (!this.port.reducedMotion() && speed >= (previous.startsWith('move') ? 60 : 80)) {
      const flying = previous.startsWith('move03'), running = previous.startsWith('move02');
      const kind = Math.abs(y) >= (flying ? 150 : 180) && speed >= (flying ? 230 : 280) && Math.abs(y) > Math.abs(x) * (flying ? .6 : .75)
        ? 'move03' : Math.abs(x) >= (running ? 480 : 600) ? 'move02' : 'move01';
      if (Math.abs(x) >= 35) this.facing = x < 0 ? 'left' : 'right';
      pose = movements.find(move => move.startsWith(kind) && moveFacing(move) === this.facing) ?? 'idle';
    }
    if (press.pose !== pose) { press.pose = pose; this.port.show(pose); }
  }

  private edges(point: Point): Edges {
    const area = this.port.workArea(point), size = this.port.size();
    return { left: area.x, top: area.y, right: Math.max(area.x, area.x + area.width - size.width),
      bottom: Math.max(area.y, area.y + area.height - size.height) };
  }

  finish(now: number, released: boolean): DragEnd | undefined {
    const press = this.press;
    if (!press) return;
    this.press = undefined;
    if (!press.active) return released ? 'click' : 'cancel';
    const origin = this.port.position();
    const velocity = released && this.movement && !this.port.reducedMotion() && press.maxDistance >= 24
      ? estimateReleaseVelocity(press.trail, now) : undefined;
    if (velocity) {
      const facing = Math.abs(velocity.x) < 35 ? this.facing : velocity.x < 0 ? 'left' : 'right';
      const choices = releases.filter(move => moveFacing(move) === facing);
      const choice = choices[Math.floor((this.port.random?.() ?? Math.random()) * choices.length)] ?? choices[0]!;
      const size = this.port.size();
      const displayPoint = { x: origin.x + size.width / 2, y: origin.y + size.height / 2 };
      this.flight = { spring: new ReleaseSpring(origin, velocity, this.edges(displayPoint)), last: now, displayPoint, facing };
      this.port.show(`release-${choice}`);
      this.port.face(facing);
    } else this.port.show('idle');
    if (released) this.port.onDrop?.(origin);
    return released ? velocity ? 'flick' : 'drop' : 'cancel';
  }

  tick(now: number) {
    if (this.press) { this.updateDrag(this.press, now); return; }
    if (this.port.reducedMotion()) { this.clearFlight(); return; }
    const flight = this.flight;
    if (flight) {
      const { spring } = flight;
      const elapsed = Math.max(0, Math.min(50, now - flight.last));
      flight.last = Math.max(flight.last, now);
      spring.setBounds(this.edges(flight.displayPoint));
      spring.advance(elapsed);
      this.port.move(spring.position());
      if (Math.abs(spring.vx) >= 60) {
        const facing = spring.vx > 0 ? 'right' : 'left';
        if (facing !== flight.facing) { flight.facing = facing; this.port.face(facing); }
      }
      if (spring.settled) { this.flight = undefined; this.holdUntil = now + 2000; }
    } else if (this.holdUntil !== undefined && now >= this.holdUntil) this.clearFlight();
  }

  cancel(now: number) { this.finish(now, false); this.clearFlight(); }
}
