import { isLegacyHandoffReply, legacyHandoffBodyLimit, type LegacyHandoffReply, type LegacyImportBatch } from '../../../packages/contracts/src/legacy-character-snapshot.ts';
import { isLocalChatInput, isLocalChatResult, localChatResponseBytes, localChatStatus, type LocalChatResult } from '../../../packages/contracts/src/local-chat.ts';
import { isKnowledgeSearchInput, isKnowledgeSearchResult, knowledgeSearchBytes, knowledgeSearchStatus, type KnowledgeSearchResult } from '../../../packages/contracts/src/knowledge-search.ts';
import { matchesChatMemory, isMemoryHistorySnapshot, isRecordInput, isRecordSnapshot, isRecordWriteResult, recordErrorStatus, recordRoutes, recordWriteLimit,
  type CharacterRecord, type RecordAction, type RecordDeleteInput, type RecordSnapshot, type RecordWriteInput } from '../../../packages/contracts/src/character-records.ts';
import { identityRecordLimit, isIdentitySnapshot, isIdentityWriteInput, isIdentityWriteResult, validIdentityInput, type IdentityResult, type IdentityWriteAction, type IdentityWriteError, type IdentityWriteResult } from '../../../packages/contracts/src/characters.ts';
import { readBoundedJSON } from './bounded-json.ts';

export const identityUnavailable = { ok: false, error: 'unavailable' } as const;

export async function requestIdentity(
  { port, token }: { port: number; token: string }, input: unknown, transport: typeof fetch = fetch,
): Promise<IdentityResult> {
  if (!validIdentityInput(input)) return identityUnavailable;
  try {
    const response = await transport(`http://127.0.0.1:${port}/v1/characters/${input.petID}/identity`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(6500), headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return response.status === 404 ? { ok: false, error: 'not-found' } : identityUnavailable;
    }
    const value = await readBoundedJSON(response, identityRecordLimit);
    return isIdentitySnapshot(value, input.petID) ? { ok: true, snapshot: value } : identityUnavailable;
  } catch { return identityUnavailable; }
}

export const identityWriteUnknown = { ok: false, error: 'write-outcome-unknown' } as const;
const writeStatus: Record<IdentityWriteError, number> = {
  invalid: 400, 'not-found': 404, 'history-not-found': 404, 'credential-like': 422, limit: 413, conflict: 409, busy: 409, unavailable: 503, 'write-outcome-unknown': 503,
};
export async function writeIdentity(
  { port, token }: { port: number; token: string }, action: IdentityWriteAction, value: unknown, transport: typeof fetch = fetch,
): Promise<IdentityWriteResult> {
  if (!isIdentityWriteInput(action, value)) return { ok: false, error: 'invalid' };
  const { petID, ...body } = value;
  const path = action === 'saveIdentity' ? 'save' : action === 'restoreIdentity' ? 'restore' : 'chat-share';
  try {
    const response = await transport(`http://127.0.0.1:${port}/v1/characters/${petID}/identity/${path}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(6500), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await readBoundedJSON(response, identityRecordLimit);
    if (!isIdentityWriteResult(result, value)) return identityWriteUnknown;
    if (result.ok ? response.status !== 200 : response.status !== writeStatus[result.error]) return identityWriteUnknown;
    return result;
  } catch { return identityWriteUnknown; }
}

export async function requestCharacterRecords(
  { port, token }: { port: number; token: string }, action: RecordAction, input: unknown, transport: typeof fetch = fetch,
) {
  const { family, method, path } = recordRoutes[action];
  if (!isRecordInput(action, input)) return method === 'GET' ? identityUnavailable : { ok: false, error: 'invalid' } as const;
  const { petID, ...body } = input;
  const scope = action === 'readMemoryHistory' && isRecordInput(action, input) ? input : undefined;
  const endpoint = scope ? path.replace(':recordId', scope.id) : path;
  const validSnapshot = (value: unknown): value is RecordSnapshot<CharacterRecord> =>
    isRecordSnapshot(family, value, petID);
  try {
    const response = await transport(`http://127.0.0.1:${port}/v1/characters/${petID}/${endpoint}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(6500), headers: { authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    });
    const value = await readBoundedJSON(response, scope ? recordWriteLimit : identityRecordLimit);
    if (scope) {
      if (response.status === 200 && isMemoryHistorySnapshot(value, scope)) return { ok: true, snapshot: value } as const;
      return response.status === 404 && isRecordWriteResult(validSnapshot, value, 0) && !value.ok &&
        (value.error === 'not-found' || value.error === 'record-not-found') ? value : identityUnavailable;
    }
    if (method === 'GET') {
      if (response.status === 200 && validSnapshot(value)) return { ok: true, snapshot: value } as const;
      return response.status === 404 && isRecordWriteResult(validSnapshot, value, 0) && !value.ok && value.error === 'not-found' ? value : identityUnavailable;
    }
    if (!isRecordWriteResult(validSnapshot, value, (input as RecordWriteInput).expectedRevision)) return identityWriteUnknown;
    if (value.ok && action === 'saveChatMemory' && isRecordInput(action, input) &&
        (value.durability === 'unchanged' || !isRecordSnapshot('memories', value.snapshot, petID) ||
         !value.snapshot.records.some(record => matchesChatMemory(record, input.messageID, input.text)))) return identityWriteUnknown;
    if (value.ok && (action === 'deleteMemory' || action === 'deleteGoal') &&
        (value.durability === 'unchanged' || value.snapshot.records.some(record => record.id === (input as RecordDeleteInput).id))) return identityWriteUnknown;
    if (value.ok && (action === 'setMemoryChatShare' || action === 'setGoalChatShare') && isRecordInput(action, input) &&
        !value.snapshot.records.some(record => record.id === input.id && (record.chatShare === true) === input.enabled)) return identityWriteUnknown;
    return response.status === (value.ok ? 200 : recordErrorStatus[value.error]) ? value : identityWriteUnknown;
  } catch { return method === 'GET' ? identityUnavailable : identityWriteUnknown; }
}

export async function requestKnowledgeSearch(
  { port, token }: { port: number; token: string }, input: unknown, transport: typeof fetch = fetch,
): Promise<KnowledgeSearchResult> {
  if (!isKnowledgeSearchInput(input)) return { ok: false, error: 'invalid' };
  const { petID, expectedRevision, query } = input;
  try {
    const response = await transport(`http://127.0.0.1:${port}/v1/characters/${petID}/memories/search`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(6500),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision, query }),
    });
    const value = await readBoundedJSON(response, knowledgeSearchBytes);
    return isKnowledgeSearchResult(value, input) && response.status === (value.ok ? 200 : knowledgeSearchStatus[value.error]) ? value : identityUnavailable;
  } catch { return identityUnavailable; }
}

export async function requestLocalChatContext(
  { port, token }: { port: number; token: string }, input: unknown, transport: typeof fetch = fetch,
): Promise<LocalChatResult> {
  if (!isLocalChatInput(input)) return { ok: false, error: 'invalid' };
  const { petID, ...body } = input;
  try {
    const response = await transport(`http://127.0.0.1:${port}/v1/characters/${petID}/chat/local-context`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(6500),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const value = await readBoundedJSON(response, localChatResponseBytes);
    return isLocalChatResult(value, petID) && response.status === (value.ok ? 200 : localChatStatus[value.error]) ? value : identityUnavailable;
  } catch { return identityUnavailable; }
}

export type LegacyHandoffWrite = { expectedRevision: number; command: { type: 'importLegacy'; value: LegacyImportBatch } | { type: 'undoLegacyImport' } };
export async function requestLegacyHandoff({ port, token, petID, write, transport = fetch }: {
  port: number; token: string; petID: string; write?: LegacyHandoffWrite; transport?: typeof fetch;
}): Promise<LegacyHandoffReply> {
  if (!validIdentityInput({ petID })) return { ok: false, error: 'invalid' };
  const unknown = { ok: false, error: write ? 'write-outcome-unknown' : 'unavailable' } as const;
  const body = JSON.stringify(write ?? {});
  if (Buffer.byteLength(body) > legacyHandoffBodyLimit) return { ok: false, error: 'limit' };
  try {
    const response = await transport(`http://127.0.0.1:${port}/v1/characters/${petID}/legacy-handoff`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(6500),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body,
    });
    const value = await readBoundedJSON(response, 1024);
    return isLegacyHandoffReply(value, response.status) ? value : unknown;
  } catch { return unknown; }
}
