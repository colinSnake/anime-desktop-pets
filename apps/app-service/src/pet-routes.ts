import type { FastifyInstance } from 'fastify';
import { isPetInput, type PetAction, type PetResult } from '../../../packages/contracts/src/pets.ts';
import type { PetWorkspace } from './pet-workspace.ts';
export function registerPetRoutes(app: FastifyInstance, workspace?: PetWorkspace) {
  const empty = { type: 'object', additionalProperties: false } as const;
  const status = (result: PetResult) => result.ok ? 200 : result.error === 'invalid' ? 400 : result.error === 'not-found' ? 404 : ['conflict','active','busy','limit','package-unavailable'].includes(result.error) ? 409 : 503;
  app.get('/v1/pets', { schema: { querystring: empty } }, async (_request, reply) => {
    const result: PetResult = workspace ? await workspace.list() : { ok: false, error: 'unavailable' };
    return reply.code(status(result)).send(result);
  });
  app.post('/v1/pets/import', { schema: { querystring: empty, body: {
    type: 'object', additionalProperties: false, required: ['paths'],
    properties: { paths: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 4096 } } },
  } } }, async (request, reply) => {
    const paths = (request.body as { paths?: unknown } | undefined)?.paths;
    const result = workspace ? await workspace.importPackages(paths) : { ok: false as const, error: 'unavailable' as const };
    return reply.code(result.ok ? 200 : result.error === 'invalid' ? 400 : result.error === 'limit' ? 409 : 503).send(result);
  });
  for (const action of ['add','clone','delete','save','theme','start','stop','applyDisplay','applyBehavior','visibility','pause','resume'] satisfies PetAction[]) {
    const path = action === 'applyDisplay' ? 'apply-display' : action === 'applyBehavior' ? 'apply-behavior' : action;
    app.post(`/v1/pets/${path}`, { schema: { querystring: empty } }, async (request, reply) => {
      const result: PetResult = !isPetInput(action, request.body) ? {ok:false,error:'invalid'} : workspace ? await workspace.mutate(action, request.body) : {ok:false,error:'unavailable'};
      return reply.code(result.ok ? 200 : result.error === 'apply-failed' ? 503 : status(result)).send(result);
    });
  }
}
