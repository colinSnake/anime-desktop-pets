import { acceptedChatText, validChatReplyText, validChatRequestID } from './online-chat.ts';
import { petId, shape } from './pets.ts';

export const chatHistoryPaths = { list: '/v1/chat/history', detail: '/v1/chat/history/detail', clear: '/v1/chat/history/clear', projects: '/v1/chat/projects', createProject: '/v1/chat/projects/create' } as const;
export const chatHistoryIPC = { list: 'pet:chat-history-list', detail: 'pet:chat-history-detail', clear: 'pet:chat-history-clear' } as const;
export const chatProjectIPC = { list: 'pet:chat-project-list', create: 'pet:chat-project-create' } as const;
export const maxChatProjects = 32;
export type ChatProject = { id: string; name: string };
export type ChatProjectList = { petID: string };
export type ChatProjectNew = { petID: string; name: string };
export type ChatProjectCreate = { petID: string; project: ChatProject };
export type ChatHistoryMethod = keyof typeof chatHistoryPaths;
export const chatHistoryPageSize = 5;
export const chatHistoryDetailSize = 6;
export const chatHistoryReplyBytes = 400 * 1024;
export type ChatHistoryTurn = { requestID: string; user: string; assistant: string; completedAt: number };
export type ChatHistorySummary = { id: string; number: number; completedAt: number; projectID?: string };
/** The continuation cursor identifies a completed turn, not its movable session. */
export type ChatHistoryPage = { rows: ChatHistorySummary[]; nextBefore: string | null };
/** A paged detail echoes its exclusive turn cursor; a latest detail has no cursor. */
export type ChatHistoryDetail = { session: ChatHistorySummary; before?: string; turns: ChatHistoryTurn[]; hasEarlier: boolean };
export type ChatHistoryList = { petID: string; before?: string; projectID?: string };
export type ChatHistoryRead = { petID: string; id: string; before?: string };
export type ChatHistoryClear = { petID: string; confirmed: true };
export const historyStatus = { invalid_request: 400, not_found: 404, busy: 409, unavailable: 503 } as const;
export type ChatHistoryError = { ok: false; error: keyof typeof historyStatus };
export type ChatHistoryListResult = { ok: true; page: ChatHistoryPage } | ChatHistoryError;
export type ChatHistoryDetailResult = { ok: true; detail: ChatHistoryDetail } | ChatHistoryError;
export type ChatHistoryClearResult = { ok: true } | ChatHistoryError;
export type ChatProjectListResult = { ok: true; projects: ChatProject[] } | ChatHistoryError;
export type ChatProjectCreateResult = { ok: true; project: ChatProject } | ChatHistoryError;
export interface ChatProjectBridge {
  list(input: ChatProjectList): Promise<ChatProjectListResult>;
  create(input: ChatProjectNew): Promise<{ ok: true; project: ChatProject } | { ok: false; error: ChatHistoryError['error'] | 'cancelled' | 'exists' | 'unregistered' }>;
}
export const validChatProjectName = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 60 &&
  value === value.trim() && !value.startsWith('.') && !/[\\/:\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
export const isChatProject = (value: unknown): value is ChatProject => shape(value, ['id', 'name']) && validChatRequestID(value.id) && validChatProjectName(value.name);
export const isChatProjectNew = (value: unknown): value is ChatProjectNew => shape(value, ['petID', 'name']) && petId(value.petID) && validChatProjectName(value.name);
export interface ChatHistoryBridge {
  list(input: ChatHistoryList): Promise<ChatHistoryListResult>;
  detail(input: ChatHistoryRead): Promise<ChatHistoryDetailResult>;
  clear(input: ChatHistoryClear): Promise<ChatHistoryClearResult>;
}
export function isHistoryInput<M extends ChatHistoryMethod>(method: M, input: unknown): input is { list: ChatHistoryList; detail: ChatHistoryRead; clear: ChatHistoryClear; projects: ChatProjectList; createProject: ChatProjectCreate }[M];
export function isHistoryInput(method: ChatHistoryMethod, input: unknown): boolean {
  if (method === 'projects') return shape(input, ['petID']) && petId(input.petID);
  if (method === 'createProject') return shape(input, ['petID', 'project']) && petId(input.petID) && isChatProject(input.project);
  if (method === 'list') return shape(input, ['petID', 'before', 'projectID']) && petId(input.petID) && (input.before === undefined || validChatRequestID(input.before)) &&
    (input.projectID === undefined || input.projectID === 'unassigned' || validChatRequestID(input.projectID));
  if (method === 'detail') return shape(input, ['petID', 'id', 'before']) && petId(input.petID) && validChatRequestID(input.id) &&
    (input.before === undefined || validChatRequestID(input.before));
  return shape(input, ['petID', 'confirmed']) && petId(input.petID) && input.confirmed === true;
}
const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const validTime = (value: unknown): value is number => positiveInteger(value) && value <= 8.64e15;
export function isHistoryTurn(value: unknown): value is ChatHistoryTurn {
  return shape(value, ['requestID', 'user', 'assistant', 'completedAt']) && validChatRequestID(value.requestID) &&
    acceptedChatText(value.user) && validChatReplyText(value.assistant) && validTime(value.completedAt);
}
export function isHistorySummary(value: unknown): value is ChatHistorySummary {
  return shape(value, ['id', 'number', 'completedAt', 'projectID']) && (value.projectID === undefined || validChatRequestID(value.projectID)) && validChatRequestID(value.id) && positiveInteger(value.number) && validTime(value.completedAt);
}
export function isHistoryPage(value: unknown): value is ChatHistoryPage {
  return shape(value, ['rows', 'nextBefore']) && Array.isArray(value.rows) && value.rows.length <= chatHistoryPageSize &&
    value.rows.every(isHistorySummary) && new Set(value.rows.map(row => row.id)).size === value.rows.length &&
    (value.nextBefore === null || value.rows.length === chatHistoryPageSize && validChatRequestID(value.nextBefore));
}
export function isHistoryDetail(value: unknown, id: string, before?: string): value is ChatHistoryDetail {
  return shape(value, ['session', 'before', 'turns', 'hasEarlier']) && isHistorySummary(value.session) && value.session.id === id && value.before === before &&
    Array.isArray(value.turns) && value.turns.length > 0 && value.turns.length <= chatHistoryDetailSize && value.turns.every(isHistoryTurn) &&
    new Set(value.turns.map(row => row.requestID)).size === value.turns.length &&
    (before === undefined ? value.turns.at(-1)?.completedAt === value.session.completedAt : validChatRequestID(before) && !value.turns.some(row => row.requestID === before)) &&
    (value.hasEarlier === false || value.hasEarlier === true && value.turns.length === chatHistoryDetailSize);
}
const isError = (value: unknown): value is ChatHistoryError => shape(value, ['ok', 'error']) && value.ok === false &&
  typeof value.error === 'string' && Object.hasOwn(historyStatus, value.error);
export const isHistoryListResult = (value: unknown): value is ChatHistoryListResult => isError(value) ||
  shape(value, ['ok', 'page']) && value.ok === true && isHistoryPage(value.page);
export const isHistoryDetailResult = (value: unknown, id: string, before?: string): value is ChatHistoryDetailResult => isError(value) ||
  shape(value, ['ok', 'detail']) && value.ok === true && isHistoryDetail(value.detail, id, before);
export const isHistoryClearResult = (value: unknown): value is ChatHistoryClearResult => isError(value) || shape(value, ['ok']) && value.ok === true;
export const isProjectListResult = (value: unknown): value is ChatProjectListResult => isError(value) ||
  shape(value, ['ok', 'projects']) && value.ok === true && Array.isArray(value.projects) && value.projects.length <= maxChatProjects &&
  value.projects.every(isChatProject) && new Set(value.projects.map(project => project.id)).size === value.projects.length;
export const chatHistoryTitle = (session: ChatHistorySummary) => `会话 ${String(session.number).padStart(2, '0')}`;
export function isHistoryResult(method: ChatHistoryMethod, input: unknown, value: unknown): value is ChatHistoryListResult | ChatHistoryDetailResult | ChatHistoryClearResult | ChatProjectListResult | ChatProjectCreateResult {
  if (method === 'projects') return isProjectListResult(value);
  if (method === 'createProject') return isError(value) || isHistoryInput(method, input) && shape(value, ['ok', 'project']) && value.ok === true &&
    isChatProject(value.project) && value.project.id === input.project.id && value.project.name === input.project.name;
  if (method === 'detail') return isHistoryInput('detail', input) && isHistoryDetailResult(value, input.id, input.before);
  if (method !== 'list') return isHistoryClearResult(value);
  if (!isHistoryInput(method, input) || !isHistoryListResult(value)) return false;
  return !value.ok || input.projectID === undefined || value.page.rows.every(row => (row.projectID ?? 'unassigned') === input.projectID);
}
