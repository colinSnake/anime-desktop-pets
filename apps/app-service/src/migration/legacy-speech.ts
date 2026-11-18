import { invalidLegacy, legacyBool, legacyJSON, legacyVersion, onlyLegacyFields } from './legacy-document.ts';

function string(value: unknown, byteLimit: number): string {
  if (typeof value !== 'string' || /\p{Cs}/u.test(value) || Buffer.byteLength(value) > byteLimit) return invalidLegacy();
  return value;
}

/** Convert the old combined settings into a private review record. This has no
 * runtime authorization; audio selection and microphone binding are separate. */
export function decodeLegacySpeechSettings(bytes: Uint8Array) {
  const value = legacyJSON(bytes);
  onlyLegacyFields(value, ['schemaVersion','platform','roomIdentifier','referenceAudioPath','referenceAudioBookmark',
    'referenceTranscript','microphoneUID','displayReplies','speakReplies','speakInteractiveBubbles','aiBubblesEnabled','aiBubblesConsentID']);
  const sourceSchema = legacyVersion(value.schemaVersion ?? 1, 1);
  const platform = value.platform ?? 'bilibili';
  if (platform !== 'bilibili' && platform !== 'douyin') return invalidLegacy();
  const roomIdentifier = string(value.roomIdentifier ?? '', 256);
  if (/[\p{Cc}\p{Cf}]/u.test(roomIdentifier)) return invalidLegacy();
  const audioPath = string(value.referenceAudioPath ?? '', 4096);
  const bookmark = string(value.referenceAudioBookmark ?? '', 64 * 1024);
  if (bookmark && Buffer.from(bookmark, 'base64').toString('base64') !== bookmark) return invalidLegacy();
  const referenceTranscript = string(value.referenceTranscript ?? '', 4096);
  const device = string(value.microphoneUID ?? '', 1024);
  const speakReplies = legacyBool(value.speakReplies ?? false), speakInteractiveBubbles = legacyBool(value.speakInteractiveBubbles ?? false);
  const consentID = value.aiBubblesConsentID == null ? undefined : string(value.aiBubblesConsentID, 36);
  if (consentID !== undefined && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(consentID)) return invalidLegacy();
  return {
    sourceSchema,
    live: { platform, roomIdentifier },
    displayReplies: legacyBool(value.displayReplies ?? true),
    recordedSpeech: { speakReplies, speakInteractiveBubbles, referenceTranscript, needsMicrophoneSelection: !!device,
      needsReferenceSelection: !!(audioPath.trim() || bookmark || referenceTranscript.trim() || speakReplies || speakInteractiveBubbles) },
    recordedBubbleConsent: { enabled: legacyBool(value.aiBubblesEnabled ?? false), ...(consentID === undefined ? {} : { consentID }) },
  };
}
