import { TASK_ANIMATION_MS, type TaskAnimation } from '../../../app-service/src/task-animation.ts';

const workClips = ['work02', 'work03', 'work04', 'work05'] as const;
type WorkGate = { blocked: boolean; reduced: boolean; showingWork: boolean; playingOpening?: boolean; finished: boolean };

/** Pure task projection consumer. Durations use the local monotonic clock after receipt. */
export class WorkPoseSchedule {
  private deadline = 0;
  private seen = 0;
  private opening = false;
  private index = 0;
  private retryAt = 0;

  receive(value: TaskAnimation, wall: number, now: number, reduced: boolean) {
    if (value.state === 'unknown') return;
    const remaining = value.expiresAt - wall;
    if (value.state !== 'working' || remaining <= 0 || remaining > TASK_ANIMATION_MS) {
      this.deadline = 0;
      this.opening = false;
      return;
    }
    // A renewal after a gap cannot revive a deferred opening from an expired lease.
    if (!this.active(now)) this.opening = false;
    this.deadline = now + remaining;
    if (value.startSerial > this.seen) {
      this.seen = value.startSerial;
      this.opening = !reduced;
    }
    if (reduced) this.opening = false;
  }

  active(now: number) { return now < this.deadline; }

  failed(now: number) { this.retryAt = now + 500; }

  next(now: number, gate: WorkGate): 'idle' | 'work' | typeof workClips[number] | undefined {
    const active = this.active(now);
    if (!active || gate.reduced) this.opening = false;
    if (gate.blocked) return;
    if (!active || gate.reduced) return gate.showingWork ? 'idle' : undefined;
    if (now < this.retryAt) return;
    if (this.opening) {
      // A new generation alone cannot restart a still-playing copy of the same clip.
      if (gate.playingOpening && !gate.finished) return;
      this.opening = false;
      return 'work';
    }
    if (!gate.showingWork || gate.finished) return workClips[this.index++ % workClips.length];
  }
}
