import { modelProbeBytes, modelProbePath, modelProbeStatus } from '../../../../packages/contracts/src/model-probe.ts';
import { DISCOVERY_BODY_LIMIT, MODEL_DISCOVERY_PATH, discoveryStatus } from './discovery-contract.ts';
import type { FastifyInstance } from 'fastify';
import type { ModelManagement } from './management.ts';
import { MODEL_BODY_LIMIT, MODEL_MANAGEMENT_PATHS, modelStatus, type ModelAction } from './management-contract.ts';

export function registerModelManagement(app: FastifyInstance, models?: ModelManagement): void {
  if (!models) return;
  const empty = { type: 'object', additionalProperties: false } as const;
  app.post(MODEL_DISCOVERY_PATH, { bodyLimit: DISCOVERY_BODY_LIMIT, schema: { querystring: empty } }, async (request, reply) => {
    const controller = new AbortController();
    const disconnected = () => { if (!reply.raw.writableFinished) controller.abort(); };
    reply.raw.once('close', disconnected);
    if (reply.raw.destroyed) controller.abort();
    try {
      const result = await models.discover(request.body, controller.signal);
      if (!controller.signal.aborted) return reply.code(discoveryStatus(result)).send(result);
      return reply.hijack();
    } finally { reply.raw.off('close', disconnected); }
  });
  app.post(modelProbePath, { bodyLimit: modelProbeBytes, schema: { querystring: empty } }, async (request, reply) => {
    const controller = new AbortController();
    const disconnected = () => { if (!reply.raw.writableFinished) controller.abort(); };
    reply.raw.once('close', disconnected);
    if (reply.raw.destroyed) controller.abort();
    try {
      const result = await models.testConnection(request.body, controller.signal);
      if (controller.signal.aborted) return reply.hijack();
      return reply.code(result.ok ? 200 : modelProbeStatus[result.error]).send(result);
    } finally { reply.raw.off('close', disconnected); }
  });
  for (const method of ['list', 'save', 'default', 'remove'] satisfies ModelAction[]) {
    app.route({ method: method === 'list' ? 'GET' : 'POST', url: MODEL_MANAGEMENT_PATHS[method],
      ...(method === 'list' ? { exposeHeadRoute: false } : {}), bodyLimit: MODEL_BODY_LIMIT, schema: { querystring: empty },
      handler: async (request, reply) => {
        const result = await models.run(method, request.body);
        return reply.code(modelStatus(result)).send(result);
      },
    });
  }
}
