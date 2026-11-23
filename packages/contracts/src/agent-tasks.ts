import { credentialLikeText } from './character-records.ts';
import { chatAttachmentLimits, chatRequestWithAttachmentsBytes, validateChatAttachments, type ChatAttachment } from './chat-attachments.ts';
import { acceptedChatText, validChatReplyText, validChatRequestID, validRoute, type ChatRoute } from './online-chat.ts';
import { petId, shape } from './pets.ts';

export const agentTaskMethods = ['create', 'list', 'read', 'cancel'] as const;
export type AgentTaskMethod = typeof agentTaskMethods[number];
export const agentTaskPath = (method: AgentTaskMethod) => `/v1/agent-tasks/${method}`;
export const agentTaskChannel = (method: AgentTaskMethod) => `pet:agent-tasks-${method}`;
export const agentTaskRequestBytes = chatRequestWithAttachmentsBytes;
export const agentTaskReplyBytes = 1024 * 1024;
export const agentTaskListLimit = 12;
const statuses = ['queued', 'running', 'completed', 'failed', 'cancelled', 'outcome-unknown'] as const;
const phases = ['admitting', 'reading', 'thinking', 'review'] as const;
export type AgentTaskStatus = typeof statuses[number];
export type AgentTaskPhase = typeof phases[number];
export const isTaskActive = (status: AgentTaskStatus) => status === 'queued' || status === 'running';
export const taskErrors = { invalid_request: 400, not_found: 404, busy: 409, conflict: 409, route_changed: 409,
  tools_unavailable: 409, limit: 409, unavailable: 503, provider_failed: 502, timed_out: 504 } as const;
export type AgentTaskError = keyof typeof taskErrors;
export const agentTaskExecutionPermissionModes = ['ask', 'full'] as const;
export type AgentTaskExecutionPermissionMode = typeof agentTaskExecutionPermissionModes[number];
export type AgentTaskExecutionPermission = { mode: AgentTaskExecutionPermissionMode };
export const defaultAgentTaskExecutionPermission: AgentTaskExecutionPermission = Object.freeze({ mode: 'ask' });
export const isAgentTaskExecutionPermission = (value: unknown): value is AgentTaskExecutionPermission =>
 shape(value, ['mode']) && agentTaskExecutionPermissionModes.some(mode => mode === value.mode);
export const normalizeAgentTaskExecutionPermission = (value: unknown): AgentTaskExecutionPermission =>
 isAgentTaskExecutionPermission(value) ? { mode: value.mode } : { ...defaultAgentTaskExecutionPermission };
export type AgentTaskOwner = { petID: string; taskID: string };
export type AgentTaskRoute = Omit<ChatRoute, 'useDefault'>;
export type AgentTaskCreate = AgentTaskOwner & { route: AgentTaskRoute; prompt: string; files: ChatAttachment[]; executionPermission?: AgentTaskExecutionPermission };
export type AgentTaskInputs = { create: AgentTaskCreate; list: { petID: string }; read: AgentTaskOwner; cancel: AgentTaskOwner };
export type AgentTaskSnapshot = AgentTaskOwner & { attemptID: string; revision: number; status: AgentTaskStatus;
  phase: AgentTaskPhase; progress: number; result?: string; error?: AgentTaskError };
type Failure = { ok: false; error: AgentTaskError };
export type AgentTaskResults = { [M in AgentTaskMethod]: Failure | (M extends 'list' ? { ok: true; tasks: AgentTaskSnapshot[] } : { ok: true; task: AgentTaskSnapshot }) };
export type AgentTaskBridge = { [M in AgentTaskMethod]: (input: AgentTaskInputs[M]) => Promise<AgentTaskResults[M]> };
export const acceptedTaskPrompt = (value: unknown): value is string => acceptedChatText(value) && !credentialLikeText(value);
export const acceptedTaskResult = (value: unknown): value is string => validChatReplyText(value) && !credentialLikeText(value);
const isError = (value: unknown): value is AgentTaskError => typeof value === 'string' && Object.hasOwn(taskErrors, value);

export function isTaskInput<M extends AgentTaskMethod>(method: M, value: unknown): value is AgentTaskInputs[M] {
 if (method === 'list') return shape(value, ['petID']) && petId(value.petID);
 if (method !== 'create') return shape(value, ['petID', 'taskID']) && petId(value.petID) && validChatRequestID(value.taskID);
 if (!shape(value, ['petID', 'taskID', 'route', 'prompt', 'files', 'executionPermission']) || !petId(value.petID) || !validChatRequestID(value.taskID) ||
  (value.executionPermission !== undefined && !isAgentTaskExecutionPermission(value.executionPermission)) ||
  !validRoute(value.route, false) || !acceptedTaskPrompt(value.prompt) || !Array.isArray(value.files) || !value.files.length || value.files.length > chatAttachmentLimits.maxFiles ||
  !value.files.every(file => shape(file, ['name', 'data', 'mediaType']) && file.mediaType === 'text/plain')) return false;
 const files = validateChatAttachments(value.files, value.prompt);
 return files.ok && files.attachments.every(file => !credentialLikeText(file.text ?? ''));
}

export function isTaskSnapshot(value: unknown): value is AgentTaskSnapshot {
 if (!shape(value, ['petID', 'taskID', 'attemptID', 'revision', 'status', 'phase', 'progress', 'result', 'error']) ||
  !petId(value.petID) || !validChatRequestID(value.taskID) || !validChatRequestID(value.attemptID) ||
  typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
  !statuses.some(status => status === value.status) || !phases.some(phase => phase === value.phase) ||
  typeof value.progress !== 'number' || !Number.isInteger(value.progress) || value.progress < 0 || value.progress > 100) return false;
 if (value.status === 'completed') return value.phase === 'review' && value.progress === 100 && value.error === undefined && acceptedTaskResult(value.result);
 if (value.phase === 'review' || value.progress === 100 || value.result !== undefined) return false;
 if (value.status === 'queued' && (value.phase !== 'admitting' || value.progress !== 0)) return false;
 return value.status === 'failed' ? isError(value.error) : value.error === undefined;
}

export function isTaskResult<M extends AgentTaskMethod>(method: M, input: AgentTaskInputs[M], value: unknown): value is AgentTaskResults[M] {
 if (shape(value, ['ok', 'error']) && value.ok === false && isError(value.error)) return true;
 if (method === 'list') return shape(value, ['ok', 'tasks']) && value.ok === true && Array.isArray(value.tasks) &&
  value.tasks.length <= agentTaskListLimit && value.tasks.every(task => isTaskSnapshot(task) && task.petID === input.petID) &&
  new Set(value.tasks.map(task => task.taskID)).size === value.tasks.length;
 return shape(value, ['ok', 'task']) && value.ok === true && isTaskSnapshot(value.task) &&
  value.task.petID === input.petID && value.task.taskID === (input as AgentTaskOwner).taskID;
}
