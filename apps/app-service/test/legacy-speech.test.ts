import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeLegacySpeechSettings } from '../src/migration/legacy-speech.ts';

const json = (settings: object) => Buffer.from(JSON.stringify(settings));
const consent = '11E0D227-61CB-4960-91D6-C19A185AFC04';
const format = { schemaVersion: 1, platform: 'douyin', roomIdentifier: 'room: demo', referenceAudioPath: '/synthetic/voice.wav',
  referenceAudioBookmark: 'YXVkaW8=', referenceTranscript: '合成样本转写', microphoneUID: 'synthetic-device',
  displayReplies: false, speakReplies: true, speakInteractiveBubbles: false, aiBubblesEnabled: true, aiBubblesConsentID: consent };

test('old speech and live settings preserve independent requests and consent history without exposing device bindings', () => {
  const decoded = decodeLegacySpeechSettings(json(format));
  assert.deepEqual(decoded, {
    sourceSchema: 1,
    live: { platform: 'douyin', roomIdentifier: 'room: demo' },
    displayReplies: false,
    recordedSpeech: { speakReplies: true, speakInteractiveBubbles: false, referenceTranscript: '合成样本转写', needsReferenceSelection: true, needsMicrophoneSelection: true },
    recordedBubbleConsent: { enabled: true, consentID: consent },
  });
  assert.doesNotMatch(JSON.stringify(decoded), /synthetic-device|voice\.wav|YXVkaW8=/);
});

test('missing fields keep legacy offline defaults and old enabling requests cannot supply missing authorization', () => {
  assert.deepEqual(decodeLegacySpeechSettings(json({})), {
    sourceSchema: 1, live: { platform: 'bilibili', roomIdentifier: '' }, displayReplies: true,
    recordedSpeech: { speakReplies: false, speakInteractiveBubbles: false, referenceTranscript: '', needsReferenceSelection: false, needsMicrophoneSelection: false },
    recordedBubbleConsent: { enabled: false },
  });
  const partial = decodeLegacySpeechSettings(json({ speakInteractiveBubbles: true, aiBubblesEnabled: true }));
  assert.equal(partial.recordedSpeech.speakReplies, false); assert.equal(partial.recordedSpeech.speakInteractiveBubbles, true);
  assert.equal(partial.recordedSpeech.needsReferenceSelection, true);
  assert.deepEqual(partial.recordedBubbleConsent, { enabled: true });
});

test('invalid or ambiguous legacy settings never produce a normalized record', () => {
  for (const payload of [json({ schemaVersion: 2 }), json({ speakReplies: 'true' }), json({ platform: 'unknown' }),
    json({ roomIdentifier: 'line\nbreak' }), json({ roomIdentifier: '花'.repeat(86) }), json({ aiBubblesConsentID: 'bad' }),
    json({ referenceAudioBookmark: 'not base64' }), json({ referenceAudioPath: 'x'.repeat(4097) }), json({ microphoneUID: { arbitrary: 'shape' } }),
    json({ providerKey: 'synthetic' }), Buffer.from('{"displayReplies":false,"displayReplies":true}'),
    Buffer.from('{"schemaVersion":5,"\\u0073chemaVersion":1}'), new Uint8Array(65_537), Uint8Array.of(0xff), Buffer.from('{')]) {
    assert.throws(() => decodeLegacySpeechSettings(payload), { message: 'invalid_legacy_document' });
  }
});
