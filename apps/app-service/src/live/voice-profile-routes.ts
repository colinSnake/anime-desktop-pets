import type { FastifyInstance } from 'fastify';
import { isLiveVoiceProfileTarget, isLiveVoiceProfileMutation, isLiveVoiceTranscriptInput, type LiveVoiceProfileResult } from '../../../../packages/contracts/src/live-voice-profile.ts';
import type { LiveVoiceProfileStore } from './voice-profiles.ts';

/** Internal authenticated management API, never mounted on the OBS source server.
 * Only the trusted main-process native selector may add `path` to select-reference.
 * Renderer IPCs must validate the path-free contracts before adding that field. */
export function registerLiveVoiceProfileRoutes(app: FastifyInstance, store?: LiveVoiceProfileStore): void {
  const pending = new Set<AbortController>();
  app.addHook('preClose', async () => { for (const job of pending) job.abort(); await store?.close(); });
  for (const action of ['read', 'select-reference', 'transcript', 'clear-reference'] as const) {
    app.post(`/v1/live/voice-profile/${action}`, { bodyLimit: 24 * 1024 }, async (request, reply) => {
      const abort = new AbortController(), cancel = () => abort.abort();
      const disconnect = () => { if (!reply.raw.writableEnded) cancel(); };
      pending.add(abort); request.raw.once('aborted', cancel); reply.raw.once('close', disconnect);
      let result: LiveVoiceProfileResult = { ok: false, error: 'invalid' };
      try {
        const body = request.body;
        if (!request.query || Object.keys(request.query).length === 0) {
          if (action === 'read' && isLiveVoiceProfileTarget(body)) result = store ? await store.read(body, abort.signal) : { ok: false, error: 'unavailable' };
          if (action === 'transcript' && isLiveVoiceTranscriptInput(body)) result = store ? await store.saveTranscript(body, abort.signal) : { ok: false, error: 'unavailable' };
          if (action === 'clear-reference' && isLiveVoiceProfileMutation(body)) result = store ? await store.clearReference(body, abort.signal) : { ok: false, error: 'unavailable' };
          if (action === 'select-reference' && body && typeof body === 'object' && !Array.isArray(body) && Object.hasOwn(body, 'path')) {
            const { path, ...input } = body as Record<string, unknown>;
            if (isLiveVoiceProfileMutation(input) && typeof path === 'string' && path.length <= 4096)
              result = store ? await store.selectReference(input, path, abort.signal) : { ok: false, error: 'unavailable' };
          }
        }
      } catch { result = { ok: false, error: 'unavailable' }; }
      finally { pending.delete(abort); request.raw.removeListener('aborted', cancel); reply.raw.removeListener('close', disconnect); }
      const status = result.ok ? 200 : ({ invalid: 400, conflict: 409, unbound: 409, cancelled: 409, 'reference-required': 422, storage: 503, unavailable: 503 } as const)[result.error];
      return reply.code(status).send(result);
    });
  }
}
