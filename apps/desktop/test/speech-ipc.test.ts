import assert from 'node:assert/strict';
import test from 'node:test';
import { speechMethods, validSpeechArgs } from '../src/speech-ipc.ts';

test('speech bridge accepts only a bounded transcript for enable; no path, text cue or device arguments', () => {
  for (const method of speechMethods) {
    if (method === 'enable') continue;
    assert.equal(validSpeechArgs(method, []), true);
    for (const input of ['known.wav', { path: 'known.wav' }, { text: 'a cue' }, undefined]) assert.equal(validSpeechArgs(method, [input]), false);
  }
  assert.equal(validSpeechArgs('enable', [{ referenceTranscript: '合成文本' }]), true);
  for (const input of ['合成文本', { referenceTranscript: '字'.repeat(1366) }, { referenceTranscript: 'abc', path: 'known.wav' }, { referenceTranscript: '\ud800' }]) assert.equal(validSpeechArgs('enable', [input]), false);
});
