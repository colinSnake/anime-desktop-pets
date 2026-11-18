import type { CodexTaskLease, TaskPresence, TaskSnapshot } from './codex-task-lease.ts';

const states = ['off', 'checking', 'waiting', 'working', 'idle', 'unknown'] as const;
export type TaskFollowingState = (typeof states)[number];
export function isTaskFollowingState(value: unknown): value is TaskFollowingState {
  return typeof value === 'string' && states.some(state => state === value);
}

type Scheduler = (callback: () => void, delay: number) => () => void;
const schedule: Scheduler = (callback, delay) => {
  const timer = setTimeout(callback, delay);
  timer.unref();
  return () => clearTimeout(timer);
};
type Ports = {
  lease: CodexTaskLease;
  probe(signal: AbortSignal): Promise<TaskPresence>;
  read(signal: AbortSignal): Promise<unknown>;
  closeReader(): Promise<void>;
  changed(state: TaskFollowingState): void;
  pose?(snapshot: TaskSnapshot | undefined): void;
  schedule?: Scheduler;
};

/** One service-owned read source, regardless of the number of pets. */
export class CodexTaskFollowing {
  private enabled = false;
  private closed = false;
  private generation = 0;
  private pending?: Promise<void>;
  private cancelTimer?: () => void;
  private state: TaskFollowingState = 'off';
  constructor(private readonly ports: Ports) {}

  setEnabled(enabled: boolean): void {
    if (this.closed || enabled === this.enabled) return;
    if (enabled && !this.ports.lease.enable()) return;
    this.generation++;
    this.enabled = enabled;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    if (!enabled) {
      this.ports.lease.disable();
      this.ports.pose?.(undefined);
      this.publish('off');
      void this.ports.closeReader().catch(() => {});
      return;
    }
    this.publish('checking');
    this.poll();
  }

  async close(): Promise<void> {
    this.setEnabled(false);
    this.closed = true;
    await this.pending;
    await this.ports.closeReader();
  }

  private publish(state: TaskFollowingState): void {
    if (this.state === state) return;
    this.state = state;
    this.ports.changed(state);
  }

  private poll(): void {
    if (!this.enabled || this.closed || this.pending) return;
    const generation = this.generation;
    const current = () => this.enabled && this.generation === generation;
    this.pending = Promise.resolve().then(async () => {
      if (!current()) return;
      const observed: { presence?: TaskPresence } = {};
      const allowed = await this.ports.lease.refresh(async signal => observed.presence = await this.ports.probe(signal));
      if (!current()) return;
      if (!allowed) {
        this.ports.pose?.(undefined);
        this.publish(observed.presence === 'not-detected' ? 'waiting' : 'unknown');
        await this.ports.closeReader();
        return;
      }
      const snapshot = await this.ports.lease.sample(signal => this.ports.read(signal));
      if (current()) {
        this.ports.pose?.(snapshot);
        this.publish(snapshot?.state ?? 'unknown');
      }
    }).catch(() => {
      if (current()) { this.ports.pose?.(undefined); this.publish('unknown'); }
    }).finally(() => {
      this.pending = undefined;
      if (!this.enabled || this.closed) return;
      if (!current()) { this.poll(); return; }
      this.cancelTimer = (this.ports.schedule ?? schedule)(() => {
        if (!current()) return;
        this.cancelTimer = undefined;
        this.poll();
      }, 2000);
    });
  }
}
