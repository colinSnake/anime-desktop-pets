import type { PlayerController, PlayerSnapshot, PlayerInitialPreferences } from '../../../packages/contracts/src/index.ts';
import type { PetDefinition, PetError, PetPhase, RuntimeBehaviorState } from '../../../packages/contracts/src/pets.ts';

type Position = { x: number; y: number };
type Owned = { controller: PlayerController; pending?: 'starting' | 'stopping'; epoch: number; positionEpoch: number; failed: boolean; applied?: { size: number; hideInFullscreen: boolean; visible: boolean }; behavior?: RuntimeBehaviorState; positionFeedback?: Position & { status: 'saving' | 'saved' | 'failed' } };
function phase(status: PlayerSnapshot['status']): PetPhase {
  return status === 'error' ? 'failed' : status === 'blocked' || status === 'unconfigured' ? 'not-connected' : status;
}
/** Volatile ownership only. No source discovery, data adoption, configuration writes or auto-start. */
export class PetLifecycle {
  private owned = new Map<string, Owned>();
  private closing?: Promise<void>;
  private paused = false;
  private positionWriter?: (id: string, position: Position) => Promise<boolean>;
  constructor(private options: { supports(pet: PetDefinition): boolean; create(pet: PetDefinition): PlayerController }) {}
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
  positionFeedback(pet: PetDefinition) { const value = this.owned.get(pet.id)?.positionFeedback; return value && { ...value }; }
  setPositionWriter(writer: (id: string, position: Position) => Promise<boolean>) { this.positionWriter = writer; }
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
      try { own = { controller: this.options.create(structuredClone(pet)), epoch: 0, positionEpoch: 0, failed: false }; }
      catch { return 'unavailable'; }
      this.owned.set(pet.id, own);
      own.controller.setPositionListener?.(position => { void this.persistPosition(pet.id, own!, position); });
    }
    own.behavior = undefined; // A new session has no confirmation until its own first frame.
    const preferences = structuredClone(pet.preferences);
    this.command(own, 'start', 'starting', () => {
      own!.applied = { size: preferences.size, hideInFullscreen: preferences.hideInFullscreen, visible: true };
      own!.behavior = { status: 'applied', scheduledActivity: preferences.scheduledActivity, movement: preferences.movement };
    }, preferences);
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
    this.command(own, 'stop', 'stopping');
  }
  async pauseAll(): Promise<boolean> {
    if (this.closing) return false;
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
    try {
      if (!await own.controller.applyDisplayPreferences({ size: pet.preferences.size, hideInFullscreen: pet.preferences.hideInFullscreen })) return 'apply-failed';
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
    own.behavior = confirmed ? { status: 'applied', ...preferences } : { status: 'failed' };
    return confirmed ? undefined : 'apply-failed';
  }
  async setVisible(pet: PetDefinition, visible: boolean): Promise<PetError | undefined> {
    const own = this.owned.get(pet.id);
    if (!own || this.phase(pet) !== 'running') return 'active';
    try {
      if (!await own.controller.setVisible(visible)) return 'apply-failed';
      own.applied = { ...(own.applied ?? { size: pet.preferences.size, hideInFullscreen: pet.preferences.hideInFullscreen }), visible };
      return;
    } catch { return 'apply-failed'; }
  }
  private command(own: Owned, command: 'start' | 'stop', pending: 'starting' | 'stopping', onStarted?: () => void, preferences?: PlayerInitialPreferences) {
    const epoch = ++own.epoch;
    own.pending = pending;
    // Invoked synchronously to preserve start/stop ordering. Only completion is async.
    let operation: Promise<PlayerSnapshot>;
    try { operation = command === 'start' ? own.controller.start(preferences) : own.controller.stop(); }
    catch { operation = Promise.reject(new Error('instance_unavailable')); }
    void operation.then(result => {
      if (own.epoch !== epoch) return;
      own.pending = undefined;
      own.failed = result.status !== (command === 'start' ? 'running' : 'stopped');
      if (command === 'stop' && !own.failed) { own.applied = undefined; own.behavior = undefined; }
      else if (!own.failed) onStarted?.();
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
