import type { BehaviorPreferences } from '../../../../packages/contracts/src/pets.ts';
import { companionDaily, companionTravel, moveFacing, movements, travelRanges, type Movement } from './locomotion';
import { clampPosition, type Point, type Size } from './motion';

// Pinned v0.5.1 interaction/idle groups. The two normal idle loops have one-shot aliases here.
export const activityVariants = ['01', '04', '05', '08', '09', '13', '14', '17', '18', '20', '21', '22', '24', '25', '26'] as const;
export const activityIdles = ['once-idle', 'once-idle2', 'idle03', 'idle04', 'idle05', 'idle06'] as const;
export type ActivityGeometry = { origin: Point; size: Size; area: Point & Size };
type ActivityGate = { visible: boolean; reduced: boolean; task: boolean; interaction: boolean; pointerNearby: boolean; ready: boolean };
type Travel = { kind: 'travel'; clip: `full-${Movement}` | `companion-travel-${Movement}`; origin: Point; travel: number; height: number; range: readonly [number, number] };
export type Activity = Travel | { kind: 'pose'; clip: typeof activityVariants[number] | typeof activityIdles[number] | typeof companionDaily[number] };

export function planTravel(move: Movement, { origin, size, area }: ActivityGeometry, companion = false): Travel | undefined {
  const safe = clampPosition(origin, size, area);
  if (safe.x !== origin.x || safe.y !== origin.y) return;
  const left = moveFacing(move) === 'left';
  const room = left ? origin.x - area.x : area.x + area.width - size.width - origin.x;
  if (room < 12) return;
  if (companion) {
    const { distance, height, range } = companionTravel[move];
    return { kind: 'travel', clip: `companion-travel-${move}`, origin, travel: Math.min(room, distance) * (left ? -1 : 1),
      height: Math.min(origin.y - area.y, height), range };
  }
  const flying = move.startsWith('move03');
  const [fraction, min, max] = flying ? [.34, 300, 640] : move.startsWith('move02') ? [.27, 240, 520] : [.18, 160, 420];
  const cap = Math.min(max, Math.max(min, Math.round(area.width * fraction)));
  const height = flying ? Math.min(origin.y - area.y, 280, Math.max(112, Math.round(area.height * .22))) : 0;
  return { kind: 'travel', clip: `full-${move}`, origin, travel: Math.min(room, cap) * (left ? -1 : 1), height, range: travelRanges[move] };
}

/** Source media time, not the release spring clock: stationary intro/tail and a bounded one-way displacement. */
export function travelPosition(plan: Travel, mediaMs: number): Point {
  const [start, stop] = plan.range;
  const t = Math.max(0, Math.min(1, (mediaMs - start) / (stop - start)));
  return { x: Math.round(plan.origin.x + plan.travel * t * t * (3 - 2 * t)),
    y: Math.round(plan.origin.y - plan.height * Math.sin(Math.PI * t) ** 2) };
}

/** Low-rate, per-instance schedule. It never owns pointer state, release physics, or saved positions. */
export class ActivitySchedule {
  private nextAt = 0;
  private lastUserActivity = -Infinity;
  private lastClip?: Activity['clip'];
  private cadence = 0;
  private readonly idleQueue: typeof activityIdles[number][] = [];
  private readonly variantQueue: typeof activityVariants[number][] = [];

  private readonly companionQueue: typeof companionDaily[number][] = [];
  private readonly companionCanTravel: boolean;
  readonly companionPoses: readonly typeof companionDaily[number][];

  constructor(now: number, private prefs: BehaviorPreferences, private readonly random = Math.random,
    private readonly companionFiles?: ReadonlySet<string>) {
    this.companionPoses = companionFiles ? companionDaily.filter(clip => companionFiles.has(clip)) : [];
    this.companionCanTravel = !!companionFiles && movements.some(move => companionFiles.has(companionTravel[move].file));
    this.prefs = { ...prefs };
    this.defer(now);
  }
  get enabled() { return this.prefs.scheduledActivity; }
  get deadline() {
    if (!this.enabled) return;
    if (this.companionFiles && !this.companionPoses.length && !(this.prefs.movement && this.companionCanTravel)) return;
    return this.nextAt;
  }
  due(now: number) { const at = this.deadline; return at !== undefined && now >= at; }
  private recent(now: number) { return now - this.lastUserActivity < 120_000; }
  defer(now: number) { this.nextAt = now + (this.recent(now) ? 36_000 + this.random() * 20_000 : 20_000 + this.random() * 14_000); }
  userActivity(now: number) { this.lastUserActivity = now; this.defer(now); }
  setPreferences(now: number, next: BehaviorPreferences) {
    if (next.scheduledActivity === this.prefs.scheduledActivity && next.movement === this.prefs.movement) return false;
    this.prefs = { ...next };
    this.defer(now);
    return true;
  }
  allows(kind: Activity['kind'], gate: ActivityGate) {
    return this.enabled && (kind !== 'travel' || this.prefs.movement) && gate.visible && !gate.reduced && !gate.task && !gate.interaction;
  }
  private take<T extends string>(pool: readonly T[], queue: T[]): T {
    if (!queue.length) {
      queue.push(...pool);
      for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [queue[i], queue[j]] = [queue[j]!, queue[i]!];
      }
    }
    const index = queue.findIndex(clip => clip !== this.lastClip);
    return queue.splice(Math.max(0, index), 1)[0]!;
  }
  plan(move: Movement, geometry: ActivityGeometry): Travel | undefined {
    if (this.companionFiles && !this.companionFiles.has(companionTravel[move].file)) return;
    return planTravel(move, geometry, !!this.companionFiles);
  }
  next(now: number, gate: ActivityGate, geometry: ActivityGeometry): Activity | undefined {
    if (!this.due(now)) return;
    this.defer(now);
    if (!this.allows('pose', gate) || gate.pointerNearby || !gate.ready) return;
    if (this.prefs.movement && this.random() < .45) {
      const available = movements.map(move => this.plan(move, geometry)).filter(plan => plan !== undefined);
      if (available.length) {
        const different = available.filter(plan => plan.clip !== this.lastClip);
        const pool = different.length ? different : available;
        const plan = pool[Math.floor(this.random() * pool.length)]!;
        this.lastClip = plan.clip;
        return plan;
      }
    }
    if (this.companionFiles) {
      if (!this.companionPoses.length) return;
      const clip = this.take(this.companionPoses, this.companionQueue);
      this.lastClip = clip;
      return { kind: 'pose', clip };
    }
    const index = this.cadence++ % 3;
    const idle = this.recent(now) ? index !== 2 : index === 2;
    const clip = idle ? this.take(activityIdles, this.idleQueue) : this.take(activityVariants, this.variantQueue);
    this.lastClip = clip;
    return { kind: 'pose', clip };
  }
}
