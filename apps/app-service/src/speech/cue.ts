export function isCue(text: unknown): text is string {
  return typeof text === 'string' && text.length <= 240 && [...text].length <= 120 &&
    Buffer.byteLength(text, 'utf8') <= 512 && text.trim() === text && text.length > 0 && !/[\p{Cc}\p{Cs}]/u.test(text);
}

export const invalidCue = Symbol('invalid-cue');
export function parseBubbleEvent(line: string): string | typeof invalidCue | undefined {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('event' in value) || value.event !== 'bubble-speech') return;
  const text = (value as Record<string, unknown>).text;
  // Exact framing rejects unknown/duplicate properties and avoids accepting ambiguous messages.
  return isCue(text) && line === JSON.stringify({ version: 3, event: 'bubble-speech', text }) ? text : invalidCue;
}
