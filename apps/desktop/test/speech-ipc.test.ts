import assert from 'node:assert/strict';
import test from 'node:test';
import { speechMethods, validSpeechArgs } from '../src/speech-ipc.ts';

test('speech bridge accepts only a bounded transcript for enable; no path, text cue or device arguments', () => {
  assert.equal((speechMethods as readonly string[]).includes('suspend'), false, 'model-resource control stays in the trusted main process');
  assert.equal((speechMethods as readonly string[]).includes('resume'), false, 'model-resource control stays in the trusted main process');
  for (const method of speechMethods) {
    if (method === 'enable' || method === 'saveTranscript') continue;
    assert.equal(validSpeechArgs(method, []), true);
    for (const input of ['known.wav', { path: 'known.wav' }, { text: 'a cue' }, undefined]) assert.equal(validSpeechArgs(method, [input]), false);
  }
  assert.equal(validSpeechArgs('enable', [{ referenceTranscript: '合成文本' }]), true);
  assert.equal(validSpeechArgs('saveTranscript', [{ referenceTranscript: '' }]), true);
  assert.equal(validSpeechArgs('saveTranscript', [{ referenceTranscript: '  ' }]), true);
  for (const input of [{ referenceTranscript: '字'.repeat(1366) }, { referenceTranscript: '\ud800' }, { referenceTranscript: 'x', audio: [] }]) assert.equal(validSpeechArgs('saveTranscript', [input]), false);
  for (const input of ['合成文本', { referenceTranscript: '字'.repeat(1366) }, { referenceTranscript: 'abc', path: 'known.wav' }, { referenceTranscript: '\ud800' }]) assert.equal(validSpeechArgs('enable', [input]), false);
});

test('preview status is an optional true-only marker, never a text or audio channel', async () => {
  const { isSpeechResult } = await import('../../../packages/contracts/src/speech.ts');
  const speech = { state: 'loading', hasReference: true };
  assert.equal(isSpeechResult({ ok: true, speech }), true);
  assert.equal(isSpeechResult({ ok: true, speech: { ...speech, previewing: true } }), true);
  for (const previewing of [false, 'true', 1, null])
    assert.equal(isSpeechResult({ ok: true, speech: { ...speech, previewing } }), false);
  for (const extra of [{ text: 'a cue' }, { path: 'known.wav' }, { audio: [] }])
    assert.equal(isSpeechResult({ ok: true, speech: { ...speech, ...extra } }), false);
});

test('speech status accepts a bounded saved transcript and true-only host capability', async () => {
  const { isSpeechResult } = await import('../../../packages/contracts/src/speech.ts');
  const speech = { state: 'disabled', hasReference: true, previewAvailable: true, referenceTranscript: '参考原话' };
  assert.equal(isSpeechResult({ ok: true, speech }), true);
  for (const changes of [{ referenceTranscript: '字'.repeat(1366) }, { referenceTranscript: '\ud800' }, { referenceTranscript: 1 },
    { hasReference: false }, { previewAvailable: false }, { storageUnavailable: 'true' }])
    assert.equal(isSpeechResult({ ok: true, speech: { ...speech, ...changes } }), false);
});


test('speech runtime readiness is a bounded status present only on an enabled voice', async () => {
  const { isSpeechResult } = await import('../../../packages/contracts/src/speech.ts');
  const speech = { state: 'enabled', hasReference: true };
  for (const runtime of ['cold', 'preparing', 'ready', 'failed'])
    assert.equal(isSpeechResult({ ok: true, speech: { ...speech, runtime } }), true);
  for (const runtime of [undefined, false, 'some/backend/file', { state: 'ready' }])
    assert.equal(isSpeechResult({ ok: true, speech: { ...speech, runtime } }), false);
  assert.equal(isSpeechResult({ ok: true, speech: { state: 'disabled', hasReference: true, runtime: 'ready' } }), false);
  assert.equal(isSpeechResult({ ok: true, speech: { state: 'enabled', hasReference: false, runtime: 'ready' } }), false);
});
