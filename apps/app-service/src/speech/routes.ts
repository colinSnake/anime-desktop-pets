import type { FastifyInstance } from 'fastify';
import { isSpeechEnableInput, isSpeechTranscriptInput, type SpeechResult } from '../../../../packages/contracts/src/speech.ts';
import type { BubbleSpeech } from './bubble-speech.ts';

export function registerSpeechRoutes(app: FastifyInstance, speech?: BubbleSpeech, eligible: () => boolean = () => false) {
  const empty = { type: 'object', additionalProperties: false } as const;
  const unavailable = { ok: false, error: 'unavailable' } as const;
  const invalid = { ok: false, error: 'invalid' } as const;
  app.get('/v1/speech/bubbles', { schema: { querystring: empty } }, (): SpeechResult => ({ ok: true, speech: speech?.status() ?? { state: 'unavailable', hasReference: false } }));
  app.post('/v1/speech/bubbles/reference', { bodyLimit: 25 * 1024, schema: { querystring: empty, body: {
    type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string', minLength: 1, maxLength: 4096 } },
  } } }, async request => speech ? speech.select((request.body as { path: string }).path) : unavailable);
  app.post('/v1/speech/bubbles/transcript', { bodyLimit: 25 * 1024, schema: { querystring: empty } }, async request => isSpeechTranscriptInput(request.body) ? speech?.saveTranscriptDraft(request.body.referenceTranscript) ?? unavailable : invalid);
  app.post('/v1/speech/bubbles/enable', { bodyLimit: 25 * 1024, schema: { querystring: empty } }, async request => isSpeechEnableInput(request.body) ? speech?.enable(request.body.referenceTranscript) ?? unavailable : invalid);
  app.post('/v1/speech/bubbles/clear-reference', { schema: { querystring: empty, body: empty } }, () => speech?.clearReference() ?? unavailable);
  app.post('/v1/speech/bubbles/preview', { bodyLimit: 1024, schema: { querystring: empty, body: {
    type: 'object', additionalProperties: false, required: ['revision', 'play'], properties: {
      revision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, play: { type: 'boolean' },
    },
  } } }, async request => {
    const command = request.body as { revision: number; play: boolean };
    return speech?.preview(command, eligible) ?? unavailable;
  });
  app.post('/v1/speech/bubbles/suspend', { schema: { querystring: empty, body: empty } }, async () =>
    speech?.suspendForVoiceDraft() ?? { ok: true, speech: { state: 'unavailable', hasReference: false } });
  app.post('/v1/speech/bubbles/resume', { schema: { querystring: empty, body: {
    type: 'object', additionalProperties: false, required: ['preload'], properties: { preload: { type: 'boolean' } },
  } } }, async request => speech?.resumeAfterVoiceDraft((request.body as { preload: boolean }).preload && eligible()) ??
    { ok: true, speech: { state: 'unavailable', hasReference: false } });
  app.post('/v1/speech/bubbles/disable', { schema: { querystring: empty, body: empty } }, async () => speech?.disable() ?? unavailable);
}
