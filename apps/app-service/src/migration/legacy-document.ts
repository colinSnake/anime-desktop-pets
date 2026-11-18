/** Pure codecs for documents deliberately supplied by a future migration boundary. */
const BYTE_LIMIT = 64 * 1024;
const encoder = new TextDecoder('utf-8', { fatal: true });
const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
export const invalidLegacy = (): never => { throw new Error('invalid_legacy_document'); };
export const graphemes = (value: string) => {
  let count = 0;
  for (const _ of segmenter.segment(value)) count++;
  return count;
};
function decode(bytes: Uint8Array): string {
  if (bytes.byteLength > BYTE_LIMIT) return invalidLegacy();
  try { return encoder.decode(bytes); } catch { return invalidLegacy(); }
}
function jsonRecord(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidLegacy();
    const keys = new Set<string>();
    // These legacy headers are flat scalar records. Scan whole JSON string tokens so
    // escaped spellings of a key count as duplicates too, but colons inside values do not.
    for (const match of text.matchAll(/("(?:\\[\s\S]|[^"\\])*")\s*(:)?/g)) {
      if (!match[2]) continue;
      const key = JSON.parse(match[1]!) as string;
      if (keys.has(key)) return invalidLegacy();
      keys.add(key);
    }
    if (Object.values(value).some(item => item !== null && typeof item === 'object')) return invalidLegacy();
    return value as Record<string, unknown>;
  } catch { return invalidLegacy(); }
}
export function legacyJSON(bytes: Uint8Array): Record<string, unknown> { return jsonRecord(decode(bytes)); }
export function legacyMarkdown(bytes: Uint8Array): { meta: Record<string, unknown>; lines: string[] } {
  const lines = decode(bytes).split(/\r\n|[\r\n\u0085\u2028\u2029]/u);
  const end = lines.indexOf('---', 1);
  if (lines[0] !== '---' || end < 2) return invalidLegacy();
  return { meta: jsonRecord(lines.slice(1, end).join('\n')), lines: lines.slice(end + 1) };
}
export function onlyLegacyFields(value: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(value).some(field => !fields.includes(field))) invalidLegacy();
}
export function legacyVersion(value: unknown, upper: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > upper) return invalidLegacy();
  return value;
}
export function legacyBool(value: unknown): boolean {
  return typeof value === 'boolean' ? value : invalidLegacy();
}
