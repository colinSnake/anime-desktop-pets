import { addAbortListener } from 'node:events';
import { petId } from '../../../../packages/contracts/src/pets.ts';

export type AgentChannelSource = 'chat' | 'voice' | 'live';
export type AgentChannelInput = { petID: string; eventID: string; text: string } & (
  | { source: 'chat' | 'voice'; occurredAt?: never }
  | { source: 'live'; occurredAt: number }
);
export type AgentChannelContext = Readonly<{
  text: string;
  source: AgentChannelSource;
  signal: AbortSignal;
  /** Check immediately before publishing each output. False after cancellation or execution settles. */
  isCurrent: () => boolean;
}>;
export type AgentChannelExecutor<T> = (context: AgentChannelContext) => T | Promise<T>;
export type AgentChannelResult<T> =
  | { status: 'completed'; value: T }
  | { status: 'failed' }
  | { status: 'cancelled'; reason: 'cancelled' | 'preempted' | 'closed' }
  | { status: 'dropped'; reason: 'busy' | 'duplicate' | 'stale' | 'rate-limited' }
  | { status: 'rejected'; reason: 'closed' | 'invalid' | 'event-capacity' | 'active-capacity' };
export type AgentChannelOptions = Readonly<{
  maxEvents?: number;
  maxLiveEvents?: number;
  maxLiveStartsPerMinute?: number;
  maxActive?: number;
  maxTextBytes?: number;
  maxLiveAgeMs?: number;
  /** Epoch clock for event freshness. A trusted adapter must not re-stamp a replay. */
  now?: () => number;
  /** Monotonic clock for elapsed receipt and rate windows. */
  elapsedNow?: () => number;
}>;

type Cancellation = Extract<AgentChannelResult<never>, { status: 'cancelled' }>;
type Turn = { source: AgentChannelSource; controller: AbortController; drained: Promise<unknown> };

function bounded(value: number | undefined, ceiling: number): number {
  if (value === undefined) return ceiling;
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw new RangeError('invalid agent channel limit');
  return value;
}

/** Service-only scheduling for already-authorized text inputs. Does not load or share any context.
 * Executors must propagate the signal and settle only once their work and cleanup are done.
 * A cancellation result can arrive before cleanup. The pet's slot stays reserved until cleanup;
 * if cleanup never settles, close stays pending rather than declaring the resources safe to reuse.
 */
export class AgentChannelCoordinator {
  private readonly active = new Map<string, Turn>();
  private readonly seen = new Set<string>();
  private readonly maxEvents: number;
  private readonly seenLive = new Map<string, number>();
  private readonly liveStarts: number[] = [];
  private readonly elapsedNow: () => number;
  private readonly maxLiveEvents: number;
  private readonly maxLiveStarts: number;
  private readonly maxActive: number;
  private readonly maxTextBytes: number;
  private readonly maxLiveAgeMs: number;
  private readonly now: () => number;
  private closing?: Promise<void>;

  constructor(options: AgentChannelOptions = {}) {
    this.maxEvents = bounded(options.maxEvents, 4096);
    this.maxLiveEvents = bounded(options.maxLiveEvents, 1024);
    this.maxLiveStarts = bounded(options.maxLiveStartsPerMinute, 8);
    this.maxActive = bounded(options.maxActive, 3);
    this.maxTextBytes = bounded(options.maxTextBytes, 12 * 1024);
    this.maxLiveAgeMs = bounded(options.maxLiveAgeMs, 15_000);
    this.now = options.now ?? Date.now;
    this.elapsedNow = options.elapsedNow ?? (() => performance.now());
  }

  async run<T>(input: AgentChannelInput, execute: AgentChannelExecutor<T>, signal?: AbortSignal): Promise<AgentChannelResult<T>> {
    if (this.closing) return { status: 'rejected', reason: 'closed' };
    if (!input || typeof input !== 'object' || typeof execute !== 'function') return { status: 'rejected', reason: 'invalid' };
    const { petID, source, eventID, text, occurredAt } = input;
    if (!petId(petID) || typeof eventID !== 'string' || eventID.length < 1 || eventID.length > 128 || /[^a-zA-Z0-9._:-]/.test(eventID) ||
        (source !== 'chat' && source !== 'voice' && source !== 'live') ||
        typeof text !== 'string' || text.length > this.maxTextBytes || Buffer.byteLength(text) > this.maxTextBytes ||
        !text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\p{Cs}]/u.test(text) ||
        (source === 'live' ? typeof occurredAt !== 'number' || !Number.isSafeInteger(occurredAt) || occurredAt < 0 : occurredAt !== undefined)) {
      return { status: 'rejected', reason: 'invalid' };
    }
    const key = `${petID}/${eventID}`;
    const fresh = () => {
      if (occurredAt === undefined) return true;
      const age = this.now() - occurredAt;
      return age >= 0 && age < this.maxLiveAgeMs;
    };
    if (source === 'live') {
      // Reconnect backlogs and pre-cancelled events must not occupy live receipt capacity.
      if (signal?.aborted) return { status: 'cancelled', reason: 'cancelled' };
      if (!fresh()) return { status: 'dropped', reason: 'stale' };
      const time = this.elapsedNow();
      // Ordered by first intake time, so full-map scans are not needed on a flood.
      for (const [id, expires] of this.seenLive) {
        if (expires > time) break;
        this.seenLive.delete(id);
      }
      if (this.seenLive.has(key)) return { status: 'dropped', reason: 'duplicate' };
      if (this.seenLive.size >= this.maxLiveEvents) return { status: 'rejected', reason: 'event-capacity' };
      this.seenLive.set(key, time + this.maxLiveAgeMs);
    } else {
      if (this.seen.has(key)) return { status: 'dropped', reason: 'duplicate' };
      if (this.seen.size >= this.maxEvents) return { status: 'rejected', reason: 'event-capacity' };
      // Manual IDs retain fail-closed process-lifetime dedupe independently of live intake.
      this.seen.add(key);
    }
    if (signal?.aborted) return { status: 'cancelled', reason: 'cancelled' };
    if (!fresh()) return { status: 'dropped', reason: 'stale' };
    const previous = this.active.get(petID);
    if (previous && (source === 'live' || previous.source !== 'live')) return { status: 'dropped', reason: 'busy' };
    if (!previous && this.active.size >= this.maxActive) {
      return source === 'live' ? { status: 'dropped', reason: 'busy' } : { status: 'rejected', reason: 'active-capacity' };
    }

    const controller = new AbortController(), owned = controller.signal;
    const upstream = signal && addAbortListener(signal, () => controller.abort('cancelled'));
    const cancelled = (): Cancellation => ({ status: 'cancelled', reason: owned.reason });
    let listener: Disposable | undefined;
    const stopped = new Promise<Cancellation>(resolve => {
      listener = addAbortListener(owned, () => resolve(cancelled()));
    });
    const isCurrent = () => !this.closing && !owned.aborted && this.active.get(petID)?.controller === controller;
    const drained = Promise.resolve().then(async (): Promise<AgentChannelResult<T>> => {
      try {
        // A reserved manual turn inherits the predecessor's cleanup barrier even if it is cancelled while waiting.
        if (previous) await previous.drained;
        if (owned.aborted) return cancelled();
        if (!fresh()) return { status: 'dropped', reason: 'stale' };
        if (source === 'live') {
          const time = this.elapsedNow();
          while (this.liveStarts.length && this.liveStarts[0]! <= time - 60_000) this.liveStarts.shift();
          if (this.liveStarts.length >= this.maxLiveStarts) return { status: 'dropped', reason: 'rate-limited' };
          // A started model call consumes quota even when it fails or is preempted.
          this.liveStarts.push(time);
        }
        const value = await execute({ text, source, signal: owned, isCurrent });
        return owned.aborted ? cancelled() : { status: 'completed', value };
      } catch {
        return owned.aborted ? cancelled() : { status: 'failed' };
      } finally {
        if (this.active.get(petID)?.controller === controller) this.active.delete(petID);
      }
    });
    // Publish the reservation before interrupting, since abort callbacks can run synchronously.
    this.active.set(petID, { source, controller, drained });
    previous?.controller.abort('preempted');
    try {
      const outcome = await Promise.race([drained, stopped]);
      if (owned.aborted) return cancelled();
      return this.closing ? { status: 'cancelled', reason: 'closed' } : outcome;
    } finally {
      listener?.[Symbol.dispose]();
      upstream?.[Symbol.dispose]();
    }
  }

  close(): Promise<void> {
    if (!this.closing) {
      const turns = [...this.active.values()];
      this.closing = Promise.all(turns.map(turn => turn.drained)).then(() => {});
      for (const turn of turns) turn.controller.abort('closed');
    }
    return this.closing;
  }
}
