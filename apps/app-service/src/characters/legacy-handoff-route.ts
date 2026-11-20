import type { FastifyInstance } from 'fastify';
import {
  legacyHandoffBodyLimit, legacyHandoffErrorStatus, type LegacyHandoffReply, type LegacyHandoffStatus,
} from '../../../../packages/contracts/src/legacy-character-snapshot.ts';
import { revision, shape } from '../../../../packages/contracts/src/pets.ts';
import type { PetWorkspace } from '../pet-workspace.ts';
import { WorkspaceError } from '../workspace-store.ts';
import { CharacterError, characterIsEmpty, isCommand, type CharacterState } from './records.ts';
import type { CharacterRepository } from './repository.ts';

const status = (state: CharacterState): LegacyHandoffStatus => ({
  revision: state.revision, mode: state.legacyImport ? 'undoable' : characterIsEmpty(state) ? 'empty' : 'occupied',
});
const querystring = { type: 'object', additionalProperties: false } as const;

export function registerLegacyHandoffRoute(app: FastifyInstance, workspace: PetWorkspace, repository: CharacterRepository) {
  app.post<{ Params: { id: string } }>('/v1/characters/:id/legacy-handoff', { schema: { querystring }, bodyLimit: legacyHandoffBodyLimit }, async (request, reply) => {
    const failure = (error: Extract<LegacyHandoffReply, { ok: false }>['error']) =>
      reply.code(legacyHandoffErrorStatus[error]).send({ ok: false, error } satisfies LegacyHandoffReply);
    const body = request.body;
    if (!shape(body, ['expectedRevision', 'command'])) return failure('invalid');
    const { expectedRevision, command } = body;
    const readOnly = Object.keys(body).length === 0;
    if (!readOnly && (!revision(expectedRevision) || !isCommand(command) || (command.type !== 'importLegacy' && command.type !== 'undoLegacyImport'))) return failure('invalid');
    try {
      return await workspace.withRegisteredInstance(request.params.id, async id => {
        if (readOnly) return { ok: true, status: status(await repository.read(id)) } satisfies LegacyHandoffReply;
        const result = await repository.apply(id, expectedRevision, command);
        if (result.durability !== 'confirmed') return failure('write-outcome-unknown');
        return { ok: true, status: status(result.state) } satisfies LegacyHandoffReply;
      });
    } catch (error) {
      if (error instanceof WorkspaceError) return failure(error.code === 'invalid' || error.code === 'not-found' || error.code === 'busy' ? error.code : 'unavailable');
      if (error instanceof CharacterError) switch (error.code) {
        case 'invalid_character_data': return failure('invalid');
        case 'character_limit': return failure('limit');
        case 'character_conflict': return failure('conflict');
        case 'character_busy': return failure('busy');
        case 'character_storage_unavailable': return failure('unavailable');
      }
      return failure(readOnly ? 'unavailable' : 'write-outcome-unknown');
    }
  });
}
