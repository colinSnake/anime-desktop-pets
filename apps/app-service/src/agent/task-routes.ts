import type { FastifyInstance } from 'fastify';
import { acceptedTaskResult, agentTaskMethods, agentTaskPath, agentTaskRequestBytes, isTaskActive, isTaskInput, normalizeAgentTaskExecutionPermission, taskErrors, type AgentTaskCreate, type AgentTaskError, type AgentTaskSnapshot } from '../../../../packages/contracts/src/agent-tasks.ts';
import { ModelError } from '../models/errors.ts';
import type { ModelManagement } from '../models/management.ts';
import type { PetWorkspace } from '../pet-workspace.ts';
import { WorkspaceError } from '../workspace-store.ts';
import { runAgentTask } from './task-runtime.ts';
import { AgentTaskStore, TaskError } from './task-store.ts';

type Active = { task: AgentTaskSnapshot; stop: AbortController; done: Promise<void> };
const modelFailure = (err: unknown): AgentTaskError => err instanceof ModelError &&
 (err.code === 'route_changed' || err.code === 'tools_unavailable' || err.code === 'timed_out') ? err.code : 'provider_failed';
export function registerAgentTasks(app: FastifyInstance, store: AgentTaskStore, workspace: PetWorkspace, models: ModelManagement) {
 const active = new Map<string, Active>();
 const shutdown = new AbortController();
 const stopObserving = workspace.observeRetirement(petID => {
  for (const job of active.values()) if (job.task.petID === petID) job.stop.abort();
 });
 const registered = <T>(petID: string, action: () => Promise<T>) => workspace.withRegisteredInstance(petID, action);
 const run = async (input: AgentTaskCreate, job: Active, revision: number) => {
  const deadline = AbortSignal.timeout(90_000);
  const signal = AbortSignal.any([job.stop.signal, shutdown.signal, deadline]);
  const { petID } = input;
  const update = async (patch: Parameters<AgentTaskStore['transition']>[1]) => {
   job.task = await registered(petID, () => store.transition(job.task, patch));
  };
  try {
   const result = await runAgentTask(input, signal, async modelInput => {
    // Catch rotation before opening the Keychain, then recheck under model ownership at dispatch.
    const current = await models.assertChatRoute(input.route);
    if (current.connectionRevision !== revision) throw new ModelError('route_changed');
    return models.completeAgentTask(input.route, revision, async dispatch => {
     await registered(petID, async () => { if (signal.aborted) throw new ModelError('cancelled'); dispatch(modelInput); });
    }, signal);
   }, async (phase, progress) => { await update({ status: 'running', phase, progress }); });
   // Order the completion commit against both pet deletion and explicit cancel.
   if (!acceptedTaskResult(result)) throw new ModelError('invalid_response');
   await registered(petID, async () => {
    if (signal.aborted) throw new ModelError('cancelled');
    await models.assertChatRoute(input.route).then(current => {
     if (current.connectionRevision !== revision) throw new ModelError('route_changed');
    });
    if (signal.aborted) throw new ModelError('cancelled');
    job.task = await store.transition(job.task, { status: 'completed', phase: 'review', progress: 100, result });
   });
  } catch (err) {
   if (!isTaskActive(job.task.status)) return;
   const { phase, progress } = job.task;
   const patch = job.stop.signal.aborted ? { status: 'cancelled', phase, progress } as const
    : shutdown.signal.aborted || deadline.aborted || err instanceof ModelError && err.code === 'timed_out' ? { status: 'outcome-unknown', phase, progress } as const
    : { status: 'failed', phase, progress, error: modelFailure(err) } as const;
   try { await update(patch); }
   catch (error) {
    if (error instanceof WorkspaceError && error.code === 'not-found') {
     // Retire the internal slot, not the user's private record. All external reads stay denied.
     await store.transition(job.task, { status: 'outcome-unknown', phase, progress }).catch(() => {});
    }
    // If bookkeeping cannot be confirmed, leave the row active for conservative restart recovery.
   }
  }
 };
 for (const method of agentTaskMethods) app.post(agentTaskPath(method), {
  bodyLimit: method === 'create' ? agentTaskRequestBytes : 1024,
  schema: { querystring: { type: 'object', additionalProperties: false } },
 }, async (request, reply) => {
  const fail = (error: AgentTaskError) => reply.code(taskErrors[error]).send({ ok: false, error });
  try {
   const input = request.body;
   if (shutdown.signal.aborted) return fail('unavailable');
   if (method === 'create') {
    if (!isTaskInput('create', input)) return fail('invalid_request');
    const admitted = { ...input, executionPermission: normalizeAgentTaskExecutionPermission(input.executionPermission) };
    const { petID, taskID, route } = admitted;
    const resolved = await models.assertChatRoute(route);
    if (resolved.tools === 'unsupported') return fail('tools_unavailable');
    const task = await registered(petID, async () => {
     if (shutdown.signal.aborted || reply.raw.destroyed) throw new TaskError('unavailable');
     if (active.size >= 3 || [...active.values()].some(job => job.task.petID === petID)) throw new TaskError('busy');
     const task = await store.create({ petID, taskID, route });
     if (shutdown.signal.aborted || reply.raw.destroyed) {
      await store.transition(task, { status: 'outcome-unknown', phase: 'admitting', progress: 0 });
      throw new TaskError('unavailable');
     }
     const stop = new AbortController(), job = { task, stop, done: Promise.resolve() };
     active.set(taskID, job);
     job.done = run(admitted, job, resolved.connectionRevision).finally(() => { active.delete(taskID); });
     return task;
    });
    return reply.send({ ok: true, task });
   }
   if (method === 'list') {
    if (!isTaskInput('list', input)) return fail('invalid_request');
    return reply.send({ ok: true, tasks: await registered(input.petID, () => store.list(input.petID)) });
   }
   if (!isTaskInput(method, input)) return fail('invalid_request');
   const { petID, taskID } = input;
   const task = await registered(petID, async () => {
    const task = await store.read(petID, taskID);
    const job = active.get(taskID);
    if (method === 'cancel' && task && job?.task.petID === petID && job.task.attemptID === task.attemptID && isTaskActive(task.status)) job.stop.abort();
    return task;
   });
   return task ? reply.send({ ok: true, task }) : fail('not_found');
  } catch (err) {
   return fail(err instanceof TaskError ? err.code : err instanceof WorkspaceError && err.code === 'not-found' ? 'not_found' :
    err instanceof ModelError && err.code === 'route_changed' ? 'route_changed' : 'unavailable');
  }
 });
 return { close: async () => { stopObserving(); shutdown.abort(); await Promise.all([...active.values()].map(job => job.done)); await store.close(); } };
}
