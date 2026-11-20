import { registerLegacyHandoffRoute } from './legacy-handoff-route.ts';
import { registerLocalChatRoute } from './local-chat.ts';
import { registerCharacterRecordRoutes } from './record-routes.ts';
import type { FastifyInstance } from 'fastify';
import { identityWriteLimit, isIdentityWriteInput, type IdentityWriteError, type IdentityWriteResult } from '../../../../packages/contracts/src/characters.ts';
import { CharacterError, type CharacterState, type Command } from './records.ts';
import type { PetWorkspace } from '../pet-workspace.ts';
import { WorkspaceError } from '../workspace-store.ts';
import type { CharacterRepository } from './repository.ts';

function identityView({ schemaVersion, petID, revision, identity, identityHistory }: CharacterState) {
  return { schemaVersion, petID, revision, identity, identityHistory };
}
const failures: Partial<Record<CharacterError['code'], [number, IdentityWriteError]>> = {
  credential_like_memory: [422, 'credential-like'], invalid_character_data: [400, 'invalid'], character_limit: [413, 'limit'], character_conflict: [409, 'conflict'], character_busy: [409, 'busy'],
  character_record_not_found: [404, 'history-not-found'], character_publication_uncertain: [503, 'write-outcome-unknown'],
  character_storage_unavailable: [503, 'unavailable'],
};
export function registerCharacterRoutes(app: FastifyInstance, workspace?: PetWorkspace, repository?: CharacterRepository) {
  if (!workspace || !repository) return;
  registerCharacterRecordRoutes(app, workspace, repository);
  registerLocalChatRoute(app, workspace, repository);
  registerLegacyHandoffRoute(app, workspace, repository);
  const querystring = { type: 'object', additionalProperties: false } as const;
  app.get<{ Params: { id: string } }>('/v1/characters/:id/identity', { schema: { querystring } }, async (request, reply) => {
    try {
      return await workspace.withRegisteredInstance(request.params.id, async id => identityView(await repository.read(id)));
    } catch (error) {
      if (error instanceof WorkspaceError) {
        if (error.code === 'invalid') return reply.code(400).send({ error: 'invalid_instance' });
        if (error.code === 'not-found') return reply.code(404).send({ error: 'instance_not_registered' });
      }
      return reply.code(503).send({ error: 'character_unavailable' });
    }
  });
  for (const action of ['save', 'restore', 'chat-share'] as const) {
    app.post<{ Params: { id: string } }>(`/v1/characters/:id/identity/${action}`, { schema: { querystring }, bodyLimit: identityWriteLimit }, async (request, reply) => {
      const failure = (status: number, error: IdentityWriteError) => reply.code(status).send({ ok: false, error } satisfies IdentityWriteResult);
      const body = request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.hasOwn(body, 'petID')) return failure(400, 'invalid');
      const input = { ...body, petID: request.params.id };
      let command: Command, expectedRevision: number;
      if (action === 'save' && isIdentityWriteInput('saveIdentity', input)) {
        command = { type: 'saveIdentity', value: input.draft }; expectedRevision = input.expectedRevision;
      } else if (action === 'restore' && isIdentityWriteInput('restoreIdentity', input)) {
        command = { type: 'restoreIdentity', revision: input.historicalRevision }; expectedRevision = input.expectedRevision;
      } else if (action === 'chat-share' && isIdentityWriteInput('setIdentityChatShare', input)) {
        command = { type: 'setIdentityChatShare', enabled: input.enabled }; expectedRevision = input.expectedRevision;
      } else return failure(400, 'invalid');
      try {
        return await workspace.withRegisteredInstance(request.params.id, async id => {
          const { state, durability } = await repository.apply(id, expectedRevision, command);
          return { ok: true, snapshot: identityView(state), durability } satisfies IdentityWriteResult;
        });
      } catch (error) {
        if (error instanceof WorkspaceError) {
          if (error.code === 'invalid') return failure(400, 'invalid');
          if (error.code === 'not-found') return failure(404, 'not-found');
          if (error.code === 'busy') return failure(409, 'busy');
          return failure(503, 'unavailable');
        }
        const mapped = error instanceof CharacterError ? failures[error.code] : undefined;
        return mapped ? failure(...mapped) : failure(503, 'write-outcome-unknown');
      }
    });
  }
}
