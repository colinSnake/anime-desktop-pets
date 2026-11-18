import type { FastifyInstance } from 'fastify';
import { isRecordInput, recordActions, recordErrorStatus, recordRoutes, recordWriteLimit,
  type RecordAction, type RecordError, type RecordFamily, type MemoryHistorySnapshot } from '../../../../packages/contracts/src/character-records.ts';
import { isKnowledgeSearchInput, knowledgeSearchBytes, knowledgeSearchStatus, type KnowledgeSearchError, type KnowledgeSearchResult } from '../../../../packages/contracts/src/knowledge-search.ts';
import { recallKnowledge } from './knowledge-recall.ts';
import { CharacterError, type CharacterState, type Command } from './records.ts';
import type { CharacterRepository } from './repository.ts';
import type { PetWorkspace } from '../pet-workspace.ts';
import { WorkspaceError } from '../workspace-store.ts';

const errors: Record<CharacterError['code'], RecordError> = {
  invalid_character_data: 'invalid', character_storage_unavailable: 'unavailable', character_conflict: 'conflict', character_busy: 'busy',
  character_record_not_found: 'record-not-found', character_publication_uncertain: 'write-outcome-unknown', character_limit: 'limit',
  credential_like_memory: 'credential-like', memory_expired: 'expired', memory_duplicate: 'duplicate', knowledge_conflict: 'knowledge-conflict',
};
function commandFor(action: RecordAction, value: unknown): { expectedRevision: number; command: Command } | undefined {
  switch (action) {
    case 'addMemory':
      if (isRecordInput(action, value)) return { expectedRevision: value.expectedRevision, command: { type: action, value: value.draft } };
      return;
    case 'addKnowledgeBatch':
      if (isRecordInput(action, value)) return { expectedRevision: value.expectedRevision, command: { type: action, value: value.drafts } };
      return;
    case 'addGoal':
      if (isRecordInput(action, value)) return { expectedRevision: value.expectedRevision, command: { type: action, value: value.draft } };
      return;
    case 'setMemoryChatShare': case 'setGoalChatShare':
      if (isRecordInput(action, value)) return { expectedRevision: value.expectedRevision, command: { type: action, id: value.id, enabled: value.enabled } };
      return;
    case 'confirmMemory': case 'withdrawMemory': case 'deleteMemory': case 'deleteGoal':
      if (isRecordInput(action, value)) return { expectedRevision: value.expectedRevision, command: { type: action, id: value.id } };
      return;
    case 'restoreMemory':
      if (isRecordInput(action, value)) return { expectedRevision: value.expectedRevision, command: { type: action, id: value.id, revision: value.historicalRevision } };
      return;
    case 'editMemory':
      if (isRecordInput(action, value)) return { expectedRevision: value.expectedRevision, command: { type: action, id: value.id, value: value.draft } };
      return;
    case 'editGoal':
      if (isRecordInput(action, value)) return { expectedRevision: value.expectedRevision, command: { type: action, id: value.id, value: value.draft } };
      return;
  }
}
function view(family: RecordFamily, { schemaVersion, petID, revision, memories, goals }: CharacterState) {
  return { schemaVersion, petID, revision, records: family === 'memories' ? memories.map(row => row.current) : goals };
}
export function registerCharacterRecordRoutes(app: FastifyInstance, workspace: PetWorkspace, repository: CharacterRepository) {
  app.post<{ Params: { id: string } }>('/v1/characters/:id/memories/search', {
    bodyLimit: knowledgeSearchBytes, schema: { querystring: { type: 'object', additionalProperties: false } },
  }, async (request, reply) => {
    const fail = (error: KnowledgeSearchError) => reply.code(knowledgeSearchStatus[error]).send({ ok: false, error } satisfies KnowledgeSearchResult);
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.hasOwn(body, 'petID')) return fail('invalid');
    const input = { ...body, petID: request.params.id };
    if (!isKnowledgeSearchInput(input)) return fail('invalid');
    try {
      return await workspace.withRegisteredInstance(input.petID, async petID => {
        const { revision, memories } = await repository.read(petID);
        if (revision !== input.expectedRevision) return fail('conflict');
        const ids = recallKnowledge(input.query, memories.map(row => row.current), new Date().toISOString());
        return { ok: true, petID, revision, ids } satisfies KnowledgeSearchResult;
      });
    } catch (error) {
      return fail(error instanceof WorkspaceError && error.code === 'not-found' ? 'not-found' : 'unavailable');
    }
  });
  for (const action of recordActions) {
    const { family, path, method } = recordRoutes[action];
    app.route<{ Params: { id: string; recordId?: string } }>({ method, url: `/v1/characters/:id/${path}`, bodyLimit: recordWriteLimit,
      schema: { querystring: { type: 'object', additionalProperties: false } },
      async handler(request, reply) {
        const fail = (error: RecordError) => reply.code(recordErrorStatus[error]).send({ ok: false, error });
        try {
          if (action === 'readMemoryHistory') {
            const input = { petID: request.params.id, id: request.params.recordId };
            if (!isRecordInput(action, input)) return fail('invalid');
            return await workspace.withRegisteredInstance(input.petID, async id => {
              const state = await repository.read(id);
              const row = state.memories.find(item => item.current.id === input.id);
              if (!row) return fail('record-not-found');
              return { schemaVersion: state.schemaVersion, petID: id, id: input.id, revision: state.revision,
                currentRevision: row.current.revision, history: row.history } satisfies MemoryHistorySnapshot;
            });
          }
          if (method === 'GET') return await workspace.withRegisteredInstance(request.params.id, async id => view(family, await repository.read(id)));
          const body = request.body;
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.hasOwn(body, 'petID')) return fail('invalid');
          const input = commandFor(action, { ...body, petID: request.params.id });
          if (!input) return fail('invalid');
          return await workspace.withRegisteredInstance(request.params.id, async id => {
            const { state, durability } = await repository.apply(id, input.expectedRevision, input.command);
            return { ok: true, snapshot: view(family, state), durability };
          });
        } catch (error) {
          if (error instanceof WorkspaceError) {
            if (error.code === 'invalid' || error.code === 'not-found' || error.code === 'busy') return fail(error.code);
            return fail('unavailable');
          }
          if (error instanceof CharacterError) return fail(errors[error.code]);
          return fail(method === 'GET' ? 'unavailable' : 'write-outcome-unknown');
        }
      },
    });
  }
}
