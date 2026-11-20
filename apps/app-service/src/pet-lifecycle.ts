import type { BehaviorPreferences, PetDefinition, PetError, PetPhase, PetPreferences, RuntimeBehaviorState, RuntimeMenuFeedback } from '../../../packages/contracts/src/pets.ts';

import type { TaskSnapshot } from './codex-task-lease.ts';
import { TASK_ANIMATION_MS, taskAnimationOff, type TaskAnimation } from './task-animation.ts';

export type OwnedStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
export type OwnedSnapshot = { status: OwnedStatus };
export type OwnedPlayer = {
  snapshot(): OwnedSnapshot;
  start(preferences: PetPreferences): Promise<OwnedSnapshot>;
  stop(): Promise<OwnedSnapshot>;
  applyDisplayPreferences(value: { size: number; hideInFullscreen: boolean }): Promise<boolean>;
  applyBehaviorPreferences(value: BehaviorPreferences): Promise<boolean>;
  setVisible(visible: boolean): Promise<boolean>;
  setPositionListener?(listener: (position: Position) => void): void;
  close(): Promise<void>;
  applyTaskAnimation?(value: TaskAnimation): void;
};
type Position = { x: number; y: number };
type Owned = { controller: OwnedPlayer; taskStartFloor: number; pending?: 'starting' | 'stopping'; epoch: number; positionEpoch: number; failed: boolean; applied?: { size: number; hideInFullscreen: boolean; visible: boolean }; behavior?: RuntimeBehaviorState; confirmedBehavior?: BehaviorPreferences; menuFeedback?: RuntimeMenuFeedback; positionFeedback?: Position & { status: 'saving' | 'saved' | 'failed' } };
function phase(status: OwnedStatus): PetPhase {
  return status === 'error' ? 'failed' : status;
}
/** Volatile ownership only. No source discovery, data adoption, configuration writes or auto-start. */
export class PetLifecycle {
  private owned = new Map<string, Owned>();
  private closing?: Promise<void>;
  private paused = false;
  private task = taskAnimationOff;
  private highestTaskStart = 0;
  private positionWriter?: (id: string, position: Position) => Promise<boolean>;
  constructor(private options: { supports(pet: PetDefinition): boolean; create(pet: PetDefinition): OwnedPlayer }) {}
  phase(pet: PetDefinition): PetPhase {
    const own = this.owned.get(pet.id);
    return own ? own.pending ?? (own.failed ? 'failed' : phase(own.controller.snapshot().status)) : this.options.supports(pet) ? 'stopped' : 'not-connected';
  }
  applied(pet: PetDefinition) { const value = this.owned.get(pet.id)?.applied; return value && { ...value }; }
  behavior(pet: PetDefinition) {
    if (this.closing || this.phase(pet) !== 'running') return undefined;
    const value = this.owned.get(pet.id)?.behavior;
    return value && { ...value };
  }
  confirmedBehavior(pet: PetDefinition) {
    const value = this.owned.get(pet.id)?.confirmedBehavior;
    return value && { ...value };
  }
  menuFeedback(pet: PetDefinition) {
    return this.phase(pet) === 'running' ? this.owned.get(pet.id)?.menuFeedback : undefined;
  }
  setMenuFeedback(pet: PetDefinition, feedback: RuntimeMenuFeedback | undefined) {
    const own = this.owned.get(pet.id);
    if (own) own.menuFeedback = feedback;
  }
  positionFeedback(pet: PetDefinition) { const value = this.owned.get(pet.id)?.positionFeedback; return value && { ...value }; }
  setPositionWriter(writer: (id: string, position: Position) => Promise<boolean>) { this.positionWriter = writer; }
  updateTaskAnimation(snapshot: TaskSnapshot | undefined): void {
    if (this.closing || this.paused) return;
    if (snapshot) this.highestTaskStart = Math.max(this.highestTaskStart, snapshot.startSerial);
    this.task = snapshot ? {
      state: snapshot.state, startSerial: snapshot.startSerial,
      expiresAt: snapshot.state === 'working' ? Date.now() + TASK_ANIMATION_MS : 0,
    } : taskAnimationOff;
    for (const own of this.owned.values()) this.sendTaskAnimation(own);
  }
  private sendTaskAnimation(own: Owned): void {
    if (this.closing || this.paused || own.pending || own.failed || own.controller.snapshot().status !== 'running') return;
    const task = this.task.state === 'working' && this.task.expiresAt <= Date.now() ? taskAnimationOff : this.task;
    try { own.controller.applyTaskAnimation?.({ ...task, startSerial: task.startSerial > own.taskStartFloor ? task.startSerial : 0 }); }
    catch { /* Optional task feedback cannot fail a player's startup or stop. */ }
  }
  start(pet: PetDefinition): PetError | undefined {
    if (this.closing) return 'unavailable';
    if (this.paused) return 'busy';
    if (!this.options.supports(pet)) return 'package-unavailable';
    if (!pet.enabled) return 'invalid';
    const current = this.phase(pet);
    if (current === 'starting' || current === 'running') return;
    if (current === 'stopping') return 'busy';
    if (current === 'failed') return 'active';
    if ([...this.owned.values()].filter(own => own.pending || own.failed || own.controller.snapshot().status !== 'stopped').length >= 3) return 'limit';
    let own = this.owned.get(pet.id);
    if (!own) {
      try { own = { controller: this.options.create(structuredClone(pet)), epoch: 0, positionEpoch: 0, failed: false, taskStartFloor: 0 }; }
      catch { return 'unavailable'; }
      this.owned.set(pet.id, own);
      own.controller.setPositionListener?.(position => { void this.persistPosition(pet.id, own!, position); });
    }
    own.menuFeedback = own.behavior = own.confirmedBehavior = undefined; // A new session has no confirmation until its own first frame.
    const preferences = structuredClone(pet.preferences);
    this.command(own, { kind: 'start', preferences, onStarted: () => {
      own!.applied = { size: preferences.size, hideInFullscreen: preferences.hideInFullscreen, visible: true };
      own!.confirmedBehavior = { scheduledActivity: preferences.scheduledActivity, movement: preferences.movement };
      own!.behavior = { status: 'applied', ...own!.confirmedBehavior };
      own!.taskStartFloor = this.highestTaskStart;
      this.sendTaskAnimation(own!);
    } });
  }
  private async persistPosition(id: string, own: Owned, position: Position) {
    const epoch = ++own.positionEpoch;
    own.positionFeedback = { ...position, status: 'saving' };
    let saved = false;
    try { saved = await this.positionWriter?.(id, position) === true; } catch { saved = false; }
    if (this.owned.get(id) === own && own.positionEpoch === epoch) {
      own.positionFeedback = { ...position, status: saved ? 'saved' : 'failed' };
    }
  }
  stop(pet: PetDefinition): PetError | undefined {
    if (this.closing) return 'unavailable';
    const own = this.owned.get(pet.id);
    if (!own || this.phase(pet) === 'stopped' || own.pending === 'stopping') return;
    this.command(own, { kind: 'stop' });
  }
  async pauseAll(): Promise<boolean> {
    if (this.closing) return false;
    this.task = taskAnimationOff;
    this.paused = true;
    const results = await Promise.all([...this.owned.values()].map(async own => {
      const current = own.controller.snapshot().status;
      if (current === 'stopped') {
        own.pending = undefined; own.failed = false; own.applied = undefined; own.behavior = undefined;
        return true;
      }
      const epoch = ++own.epoch;
      own.pending = 'stopping'; own.behavior = undefined;
      let stopped = false;
      try { stopped = (await own.controller.stop()).status === 'stopped'; } catch { /* keep ownership and the failed slot */ }
      if (own.epoch === epoch) {
        own.pending = undefined; own.failed = !stopped;
        if (stopped) own.applied = undefined;
      }
      return stopped;
    }));
    return results.every(Boolean);
  }
  resumeAll(): void { this.paused = false; }
  async applyDisplayPreferences(pet: PetDefinition): Promise<PetError | undefined> {
    const own = this.owned.get(pet.id);
    if (!own || this.phase(pet) !== 'running') return 'active';
    const epoch = own.epoch;
    try {
      if (!await own.controller.applyDisplayPreferences({ size: pet.preferences.size, hideInFullscreen: pet.preferences.hideInFullscreen }) ||
          this.closing || own.epoch !== epoch || this.phase(pet) !== 'running') return 'apply-failed';
      own.applied = { ...(own.applied ?? { visible: true }), size: pet.preferences.size, hideInFullscreen: pet.preferences.hideInFullscreen };
      return;
    } catch { return 'apply-failed'; }
  }
  async applyBehaviorPreferences(pet: PetDefinition): Promise<PetError | undefined> {
    if (this.closing) return 'unavailable';
    const own = this.owned.get(pet.id);
    if (!own || this.phase(pet) !== 'running') return 'active';
    const epoch = own.epoch;
    const preferences = { scheduledActivity: pet.preferences.scheduledActivity, movement: pet.preferences.movement };
    let confirmed = false;
    try { confirmed = await own.controller.applyBehaviorPreferences(preferences); } catch { /* no unconfirmed success */ }
    if (this.closing || own.epoch !== epoch || this.phase(pet) !== 'running') return 'apply-failed';
    if (confirmed) own.confirmedBehavior = preferences;
    own.behavior = !confirmed ? { status: 'failed' } : { status: 'applied', ...preferences };
    return confirmed ? undefined : 'apply-failed';
  }
  async setVisible(pet: PetDefinition, visible: boolean): Promise<PetError | undefined> {
    const own = this.owned.get(pet.id);
    if (!own || this.phase(pet) !== 'running') return 'active';
    const epoch = own.epoch;
    try {
      if (!await own.controller.setVisible(visible) || this.closing || own.epoch !== epoch || this.phase(pet) !== 'running') return 'apply-failed';
      own.applied = { ...(own.applied ?? { size: pet.preferences.size, hideInFullscreen: pet.preferences.hideInFullscreen }), visible };
      return;
    } catch { return 'apply-failed'; }
  }
  private command(own: Owned, command: { kind: 'start'; preferences: PetPreferences; onStarted: () => void } | { kind: 'stop' }) {
    const epoch = ++own.epoch;
    own.pending = command.kind === 'start' ? 'starting' : 'stopping';
    // Invoked synchronously to preserve start/stop ordering. Only completion is async.
    let operation: Promise<OwnedSnapshot>;
    try { operation = command.kind === 'start' ? own.controller.start(command.preferences) : own.controller.stop(); }
    catch { operation = Promise.reject(new Error('instance_unavailable')); }
    void operation.then(result => {
      if (own.epoch !== epoch) return;
      own.pending = undefined;
      own.failed = result.status !== (command.kind === 'start' ? 'running' : 'stopped');
      if (!own.failed) {
        if (command.kind === 'stop') { own.applied = undefined; own.behavior = undefined; }
        else command.onStarted();
      }
    }, () => {
      if (own.epoch === epoch) { own.pending = undefined; own.failed = true; }
    });
  }
  async forget(pet: PetDefinition): Promise<void> {
    const own = this.owned.get(pet.id);
    if (!own) return;
    if (this.phase(pet) !== 'stopped') throw new Error('instance_active');
    await own.controller.close();
    this.owned.delete(pet.id);
  }
  close(): Promise<void> {
    // Defer closers so closing is set before invoking any factory-controlled code.
    this.closing ??= Promise.resolve().then(async () => {
      const results = await Promise.allSettled([...this.owned.values()].map(own => Promise.resolve().then(() => own.controller.close())));
      if (results.some(result => result.status === 'rejected')) throw new Error('instance_cleanup_failed');
    });
    return this.closing;
  }
}
