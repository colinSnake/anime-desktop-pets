import { packLiveVoice } from '../../../../packages/contracts/src/live-voice.ts';
import type { BubbleSpeech } from '../speech/bubble-speech.ts';
import type { FastifyInstance } from 'fastify';
import { isLiveProfile, type LiveProfileResult } from '../../../../packages/contracts/src/live-stage.ts';
import type { LiveProfileStore } from './profile.ts';

export function registerLiveProfile(app: FastifyInstance, store?: LiveProfileStore, available?: () => boolean) {
  const querystring = { type: 'object', additionalProperties: false } as const;
  const unavailable = {ok:false,error:'unavailable'} as const;
  app.get('/v1/live/stage-profile', { schema: { querystring } }, async (): Promise<LiveProfileResult> => {
    if (!store) return unavailable;
    try { return {ok:true,profile:await store.read()}; } catch { return {ok:false,error:'storage'}; }
  });
  app.post('/v1/live/stage-profile', { schema: { querystring }, bodyLimit: 2048 }, async (req, res): Promise<LiveProfileResult> => {
    if (!isLiveProfile(req.body)) { res.code(400); return unavailable; }
    if (!store) return unavailable;
    if (!available?.()) return {ok:false,error:'busy'};
    try { return {ok:true,profile:await store.write(req.body)}; } catch { return {ok:false,error:'storage'}; }
  });
}


/** Trusted main-process route; the separate OBS listener exposes no synthesis commands. */
export function registerLiveVoice(app: FastifyInstance, speech: BubbleSpeech | undefined, allowed: () => boolean) {
  const empty = { type:'object', additionalProperties:false } as const;
  app.post('/v1/live/voice', {bodyLimit:64,schema:{querystring:empty,body:empty}}, async (_request, reply) => {
    reply.header('cache-control','no-store');
    if (!speech) return reply.code(503).send();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    reply.raw.once('close',cancel);
    try {
      const result = await speech.prepareStageVoice(controller.signal, allowed);
      if (!result.ok) return reply.code(result.error === 'voice-busy' ? 409 : result.error === 'reference-required' ? 422 : 503).send();
      return reply.type('application/octet-stream').send(packLiveVoice(result.clips));
    } catch { return reply.code(503).send(); }
    finally { reply.raw.removeListener('close',cancel); }
  });
}
