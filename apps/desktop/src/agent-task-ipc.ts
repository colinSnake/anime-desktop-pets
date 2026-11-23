import { isTaskInput, isTaskResult, type AgentTaskInputs, type AgentTaskMethod, type AgentTaskResults } from '../../../packages/contracts/src/agent-tasks.ts';

const invalid = { ok: false, error: 'invalid_request' } as const;
export const taskUnavailable = { ok: false, error: 'unavailable' } as const;
export class AgentTaskIPC {
 private readonly pending = new Set<AgentTaskMethod>();
 private pendingCreate?: AbortController;
 invalidateCreate(): void { this.pendingCreate?.abort(); }
 constructor(private readonly request: <M extends AgentTaskMethod>(method: M, input: AgentTaskInputs[M], signal?: AbortSignal) => Promise<unknown>) {}
 async invoke<M extends AgentTaskMethod>(method: M, eligible: () => boolean, args: unknown[]): Promise<AgentTaskResults[M]> {
  const [input] = args;
  if (!eligible() || args.length !== 1 || !isTaskInput(method, input)) return invalid;
  if (this.pending.has(method)) return { ok: false, error: 'busy' };
  this.pending.add(method);
  const create = method === 'create' ? this.pendingCreate = new AbortController() : undefined;
  try {
   const reply = await this.request(method, input, create?.signal);
   return !create?.signal.aborted && eligible() && isTaskResult(method, input, reply) ? reply : taskUnavailable;
  } catch { return taskUnavailable; }
  finally { this.pending.delete(method); if (create) this.pendingCreate = undefined; }
 }
}
