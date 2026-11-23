export const chatAttachmentLimits = Object.freeze({
  maxFiles: 5,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 15 * 1024 * 1024,
  maxTextCharacters: 20_000,
  maxTotalCharacters: 60_000,
});

const maxEncodedBytes = 4 * Math.ceil(chatAttachmentLimits.maxTotalBytes / 3);
export const chatRequestWithAttachmentsBytes = 64 * 1024 + maxEncodedBytes + chatAttachmentLimits.maxFiles * 256 + 4096;
const encoder = new TextEncoder();
const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
function textCount(value: string, limit: number): number {
  let count = 0;
  for (const _ of segmenter.segment(value)) if (++count > limit) break;
  return count;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export type ChatAttachment = {
  name: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'application/pdf' | 'text/plain';
  data: string;
};
export type ValidatedChatAttachment = ChatAttachment & { bytes: Uint8Array; text?: string };
export type ChatAttachmentValidation = { ok: true; attachments: ValidatedChatAttachment[] } | { ok: false };

const textExtensions = new Set([
  'c', 'cc', 'cfg', 'cjs', 'cpp', 'css', 'csv', 'go', 'h', 'hpp', 'ini', 'java', 'js', 'json',
  'jsx', 'log', 'md', 'mjs', 'py', 'rs', 'sh', 'sql', 'toml', 'ts', 'tsx', 'txt', 'xml', 'yaml', 'yml',
]);
const extensions: Readonly<Record<ChatAttachment['mediaType'], readonly string[]>> = {
  'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/webp': ['webp'], 'application/pdf': ['pdf'],
  'text/plain': [...textExtensions],
};

export const chatTextFileAccept = extensions['text/plain'].map(ext => `.${ext}`).join(',');
export function chatFileType(name: string): ChatAttachment['mediaType'] | undefined {
  const dot = name.lastIndexOf('.');
  if (!safeName(name) || dot <= 0) return;
  const extension = name.slice(dot + 1).toLowerCase();
  return (Object.keys(extensions) as ChatAttachment['mediaType'][]).find(type => extensions[type].includes(extension));
}
export const attachmentModality = (file: Pick<ChatAttachment, 'mediaType'>) => file.mediaType === 'text/plain' ? undefined : file.mediaType === 'application/pdf' ? 'pdf' as const : 'image' as const;

function decodeCanonicalBase64(value: unknown): Uint8Array | undefined {
  if (typeof value !== 'string' || !value.length || value.length > 4 * Math.ceil(chatAttachmentLimits.maxFileBytes / 3) || value.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return;
  try {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    // Check unused padding bits without allocating a second encoded copy.
    const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
    if (padding && alphabet.indexOf(value[value.length - padding - 1]!) % (padding === 2 ? 16 : 4)) return;
    const raw = atob(value), bytes = new Uint8Array(raw.length);
    for (let i = 0; i < bytes.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  } catch { return; }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function matchesSignature(mediaType: ChatAttachment['mediaType'], bytes: Uint8Array): boolean {
  if (mediaType === 'text/plain') return true;
  if (mediaType === 'image/png') return bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
  if (mediaType === 'image/jpeg') return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  if (mediaType === 'image/webp') return bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP' && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) + 8 === bytes.length;
  return bytes.length >= 8 && new TextDecoder().decode(bytes.subarray(0, 8)).startsWith('%PDF-');
}

function safeName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && encoder.encode(value).byteLength <= 128 && value.length > 0 && value !== '.' && value !== '..' &&
    !/[:\\/\p{Cc}\p{Cf}\p{Cs}]/u.test(value) && !value.endsWith('.') && !value.endsWith(' ');
}

export function validateChatAttachments(value: unknown, question: unknown): ChatAttachmentValidation {
  if (value === undefined) return { ok: true, attachments: [] };
  if (!Array.isArray(value) || value.length > chatAttachmentLimits.maxFiles || typeof question !== 'string') return { ok: false };
  const attachments: ValidatedChatAttachment[] = [], names = new Set<string>();
  let totalBytes = 0, totalCharacters = textCount(question, chatAttachmentLimits.maxTotalCharacters);
  if (totalCharacters > chatAttachmentLimits.maxTotalCharacters) return { ok: false };
  for (const item of value) {
    if (!record(item) || Object.keys(item).length !== 3 || !Object.hasOwn(item, 'name') ||
        !Object.hasOwn(item, 'mediaType') || !Object.hasOwn(item, 'data') || !safeName(item.name) ||
        typeof item.mediaType !== 'string' || !Object.hasOwn(extensions, item.mediaType)) return { ok: false };
    const mediaType = item.mediaType as ChatAttachment['mediaType'];
    if (chatFileType(item.name) !== mediaType) return { ok: false };
    const key = item.name.toLocaleLowerCase('en-US');
    if (names.has(key)) return { ok: false };
    names.add(key);
    const bytes = decodeCanonicalBase64(item.data);
    if (!bytes || bytes.length === 0 || bytes.length > chatAttachmentLimits.maxFileBytes || !matchesSignature(mediaType, bytes)) return { ok: false };
    totalBytes += bytes.length;
    if (totalBytes > chatAttachmentLimits.maxTotalBytes) return { ok: false };
    let text: string | undefined;
    if (mediaType === 'text/plain') {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { ok: false }; }
      const count = textCount(text, chatAttachmentLimits.maxTextCharacters);
      if (!text.trim() || count > chatAttachmentLimits.maxTextCharacters || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(text)) return { ok: false };
      totalCharacters += count;
      if (totalCharacters > chatAttachmentLimits.maxTotalCharacters) return { ok: false };
    }
    attachments.push({ name: item.name, mediaType, data: item.data as string, bytes, ...(text === undefined ? {} : { text }) });
  }
  return { ok: true, attachments };
}
