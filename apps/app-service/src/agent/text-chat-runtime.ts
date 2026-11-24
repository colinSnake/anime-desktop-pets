import type { AgentStateStore, RunTerminalStatus } from './agent-state.ts';
import { validChatReplyText, type OnlineChatInput } from '../../../../packages/contracts/src/online-chat.ts';
import { ModelError } from '../models/errors.ts';
import { WorkspaceError } from '../workspace-store.ts';
import { setTimeout as delay } from 'node:timers/promises';

/** Trusted adapter. Only the current text and a turn-scoped Provider callback cross this boundary. */
export type TextChatRuntime = (text: string, complete: (text: string) => Promise<string>, signal: AbortSignal) => Promise<string>;

export class AgentCleanupError extends Error {
  constructor() { super('agent_cleanup_unconfirmed'); }
}

const maxActive = 3, maxTurns = 1024, deadlineMs = 65_000;

/** Service-only admission for an explicitly composed Runtime. Never retries or falls back. */
export class TextChatTurns {
  private closed = false;
  private cleanupUnconfirmed = false;
  private readonly running = new Set<Promise<void>>();
  private readonly seen = new Set<string>();
  private readonly active = new Map<string, AbortController>();

  constructor(private readonly runtime: TextChatRuntime, private readonly state?: AgentStateStore) {}

  async run({ requestID, petID, text }: OnlineChatInput, provider: (signal: AbortSignal) => Promise<string>, signal: AbortSignal,
    verification: { before?: (signal: AbortSignal) => Promise<void>; after?: (signal: AbortSignal) => Promise<void>; publish?: (text: string, signal: AbortSignal, commit: () => Promise<void>) => Promise<void>; materialTurn?: boolean } = {}): Promise<string> {
    if (this.closed || this.cleanupUnconfirmed) throw new ModelError('closed');
    if (signal.aborted) throw new ModelError('cancelled');
    if (this.seen.has(requestID)) throw new ModelError('invalid_request');
    if (this.active.has(petID) || this.active.size >= maxActive || this.seen.size >= maxTurns) throw new ModelError('busy');
    // Fail closed at capacity; evicting IDs would allow replay of an unknown outcome.
    this.seen.add(requestID);
    const controller = new AbortController(), owned = controller.signal;
    this.active.set(petID, controller);
    const timer = setTimeout(() => controller.abort(new ModelError('timed_out')), deadlineMs);
    const expires = performance.now() + deadlineMs;
    const cancel = () => controller.abort(new ModelError('cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    const check = () => {
      if (performance.now() >= expires) controller.abort(new ModelError('timed_out'));
      owned.throwIfAborted();
    };
    let rejectStopped!: () => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      rejectStopped = () => reject(owned.reason);
      owned.addEventListener('abort', rejectStopped, { once: true });
    });
    let providerWork: Promise<string> | undefined, providerText: string | undefined, providerError: unknown;
    const complete = async (requestedText: string) => {
      if (owned.aborted || providerWork || requestedText !== text) throw new ModelError('invalid_request');
      check();
      providerWork = Promise.resolve().then(async () => {
        check();
        try {
          const response = await provider(owned);
          check();
          providerText = response;
          return response;
        } catch (error) { providerError = error; throw error; }
      });
      return providerWork;
    };
    let began = false, completed = false, stoppedBy: ModelError | undefined;
    const result = Promise.resolve().then(async () => {
      check();
      await verification.before?.(owned);
      check();
      await this.state?.begin({ requestID, petID, source: 'chat' });
      began = !!this.state;
      check();
      // A material provider callback already runs the same Pi loop with scoped tools.
      // Ordinary chat instead uses Pi's tool-free adapter, never both for one turn.
      const final = await (verification.materialTurn ? complete(text) : this.runtime(text, complete, owned));
      check();
      if (!validChatReplyText(final) || providerText === undefined || final.trim() !== providerText) throw new ModelError('invalid_response');
      await verification.after?.(owned);
      check();
      const commit = async () => {
        check();
        if (this.state) {
          try { await this.state.finish(requestID, 'completed', owned); }
          catch {
            if (owned.aborted) throw owned.reason;
            this.cleanupUnconfirmed = true;
            throw new AgentCleanupError();
          }
        }
        completed = true;
      };
      if (verification.publish) await verification.publish(final.trim(), owned, commit);
      else await commit();
      if (!completed) throw new ModelError('invalid_response');
      return final.trim();
    });
    const drained = result.then(() => {}, () => {})
      .then(() => providerWork?.then(() => {}, () => {}))
      .then(async () => {
        if (this.state && began && !completed) {
          const status: RunTerminalStatus = stoppedBy?.code === 'closed' ? 'interrupted' : stoppedBy?.code === 'cancelled' ? 'cancelled' : 'failed';
          try { await this.state.finish(requestID, status); }
          catch { this.cleanupUnconfirmed = true; }
        }
      });
    this.running.add(drained);
    try {
      const final = await Promise.race([result, stopped]);
      check();
      return final;
    } catch (error) {
      if (owned.aborted) { stoppedBy = owned.reason; throw owned.reason; }
      if (error instanceof AgentCleanupError) throw new ModelError('closed');
      if (providerError instanceof ModelError || providerError instanceof WorkspaceError) throw providerError;
      if (error instanceof ModelError || error instanceof WorkspaceError) throw error;
      throw new ModelError(providerWork ? 'upstream_unavailable' : 'closed');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      owned.removeEventListener('abort', rejectStopped);
      controller.abort(new ModelError('cancelled'));
      // Keep the slot occupied until the adapter has settled (including cancellation cleanup).
      const release = () => { this.active.delete(petID); this.running.delete(drained); };
      void drained.then(release);
    }
  }

  async close() {
    this.closed = true;
    for (const controller of this.active.values()) controller.abort(new ModelError('closed'));
    const timer = new AbortController();
    try {
      const expired = await Promise.race([
        Promise.all(this.running).then(() => false), delay(6500, true, { signal: timer.signal }),
      ]);
      if (expired || this.cleanupUnconfirmed) throw new AgentCleanupError();
    } finally { timer.abort(); }
  }
}
