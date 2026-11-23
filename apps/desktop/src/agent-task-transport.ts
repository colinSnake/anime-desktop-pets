import { agentTaskPath, agentTaskReplyBytes, isTaskInput, isTaskResult, taskErrors, type AgentTaskError, type AgentTaskInputs, type AgentTaskMethod, type AgentTaskResults } from '../../../packages/contracts/src/agent-tasks.ts';
import { readBoundedJSON } from './bounded-json.ts';
import { taskUnavailable } from './agent-task-ipc.ts';

export async function requestAgentTask<M extends AgentTaskMethod>(session: { port: number; token: string }, method: M, input: AgentTaskInputs[M], signal?: AbortSignal): Promise<AgentTaskResults[M]> {
 if (!isTaskInput(method, input)) return { ok: false, error: 'invalid_request' };
 try {
  const deadline = AbortSignal.timeout(8000);
  const response = await fetch(`http://127.0.0.1:${session.port}${agentTaskPath(method)}`, {
   method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
   headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  const value = await readBoundedJSON(response, agentTaskReplyBytes);
  return isTaskResult(method, input, value) && response.status === (value.ok ? 200 : taskErrors[(value as { error: AgentTaskError }).error]) ? value : taskUnavailable;
 } catch { return taskUnavailable; }
}
