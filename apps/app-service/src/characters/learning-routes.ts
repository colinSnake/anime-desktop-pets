import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  characterLearningPaths, characterLearningRequestBytes, isCharacterLearningChatSelection, isCharacterLearningGenerateInput, isCharacterLearningInput,
  type CharacterLearningErrorCode,
} from '../../../../packages/contracts/src/character-learning.ts';
import type { CharacterLearning } from './learning.ts';
const status: Record<CharacterLearningErrorCode, number> = {
  invalid: 400, expired: 410, conflict: 409, cancelled: 409, busy: 409, 'rate-limited': 429, duplicate: 409,
  'model-unavailable': 412, 'invalid-candidate': 422, unavailable: 503, 'write-outcome-unknown': 503,
};
const invalid = (reply: FastifyReply) => reply.code(400).send({ ok: false, error: 'invalid' });
async function untilDisconnected<T>(request: FastifyRequest, reply: FastifyReply, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController(), cancel = () => abort.abort();
  request.raw.once('aborted', cancel); reply.raw.once('close', cancel);
  if (reply.raw.destroyed) cancel();
  try { return await run(abort.signal); }
  finally { request.raw.removeListener('aborted', cancel); reply.raw.removeListener('close', cancel); }
}
/** Register only on the authenticated private management service, never OBS. */
export function registerCharacterLearningRoutes(app: FastifyInstance, learning: CharacterLearning) {
  const options = { bodyLimit: characterLearningRequestBytes, schema: { querystring: { type: 'object', additionalProperties: false } } };
  app.post(characterLearningPaths.selectChatTurn, options, async (request, reply) => {
    const input = request.body;
    if (!isCharacterLearningChatSelection(input)) return invalid(reply);
    const result = await untilDisconnected(request, reply, signal => learning.selectChatTurn(input, signal));
    return reply.header('cache-control', 'no-store').code(result.ok ? 200 : status[result.error]).send(result);
  });
  app.post(characterLearningPaths.preview, options, async (request, reply) => {
    const input = request.body;
    if (!isCharacterLearningInput(input)) return invalid(reply);
    const result = await untilDisconnected(request, reply, signal => learning.preview(input, signal));
    return reply.header('cache-control', 'no-store').code(result.ok ? 200 : status[result.error]).send(result);
  });
  app.post(characterLearningPaths.generate, options, async (request, reply) => {
    const input = request.body;
    if (!isCharacterLearningGenerateInput(input)) return invalid(reply);
    const result = await untilDisconnected(request, reply, signal => learning.generate(input, signal));
    return reply.code(result.ok ? 200 : status[result.error]).send(result);
  });
  app.post(characterLearningPaths.cancel, options, async (request, reply) => {
    if (!isCharacterLearningInput(request.body)) return invalid(reply);
    const result = learning.cancel(request.body);
    return reply.code(result.ok ? 200 : status[result.error]).send(result);
  });
}
