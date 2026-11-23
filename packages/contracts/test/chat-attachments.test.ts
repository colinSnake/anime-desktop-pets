import assert from 'node:assert/strict';
import test from 'node:test';
import { chatAttachmentLimits, validateChatAttachments } from '../src/chat-attachments.ts';
import { validOnlineChatInput } from '../src/online-chat.ts';

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const pdf = new TextEncoder().encode('%PDF-1.7\n');
const base64 = (bytes: Uint8Array) => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
};
const attachment = (name: string, mediaType: string, bytes: Uint8Array) => ({ name, mediaType, data: base64(bytes) });

test('validates supported image and PDF signatures against declared type and filename', () => {
  const result = validateChatAttachments([
    attachment('chart.png', 'image/png', png), attachment('photo.jpeg', 'image/jpeg', jpeg),
    attachment('preview.webp', 'image/webp', webp), attachment('brief.pdf', 'application/pdf', pdf),
  ], '请看附件');
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.attachments.map(file => file.mediaType), ['image/png', 'image/jpeg', 'image/webp', 'application/pdf']);
});

test('accepts only bounded UTF-8 text attachments from the fixed extension allowlist', () => {
  const result = validateChatAttachments([attachment('notes.md', 'text/plain', new TextEncoder().encode('第一行\nsecond line'))], '归纳要点');
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.attachments[0]!.text, '第一行\nsecond line');
  for (const name of ['notes.exe', '../notes.md', 'folder/notes.md', 'folder\\notes.md', '.md']) {
    assert.equal(validateChatAttachments([attachment(name, 'text/plain', new TextEncoder().encode('内容'))], '问题').ok, false, name);
  }
});

test('rejects forged or noncanonical attachment payloads and unknown DTO fields', () => {
  assert.equal(validateChatAttachments([attachment('image.jpg', 'image/jpeg', png)], '说明').ok, false);
  assert.equal(validateChatAttachments([attachment('image.png', 'image/png', jpeg)], '说明').ok, false);
  assert.equal(validateChatAttachments([{ ...attachment('notes.txt', 'text/plain', new Uint8Array([0xff])), path: '/private/file' }], '说明').ok, false);
  assert.equal(validateChatAttachments([{ ...attachment('notes.txt', 'text/plain', new TextEncoder().encode('x')), data: 'eB==' }], '说明').ok, false);
  assert.equal(validateChatAttachments([{ ...attachment('notes.txt', 'text/plain', new TextEncoder().encode('x')), extra: true }], '说明').ok, false);
});

test('enforces count, byte, per-text, and composed character budgets', () => {
  const sample = new TextEncoder().encode('x');
  assert.equal(validateChatAttachments(Array.from({ length: chatAttachmentLimits.maxFiles }, (_, index) => attachment(`f${index}.txt`, 'text/plain', sample)), '问题').ok, true);
  assert.equal(validateChatAttachments(Array.from({ length: chatAttachmentLimits.maxFiles + 1 }, (_, index) => attachment(`f${index}.txt`, 'text/plain', sample)), '问题').ok, false);
  const tooManyChars = new TextEncoder().encode('字'.repeat(chatAttachmentLimits.maxTextCharacters + 1));
  assert.equal(validateChatAttachments([attachment('long.txt', 'text/plain', tooManyChars)], '问题').ok, false);
  const tooLarge = new Uint8Array(chatAttachmentLimits.maxFileBytes + 1);
  tooLarge.set(pdf);
  assert.equal(validateChatAttachments([attachment('large.pdf', 'application/pdf', tooLarge)], '问题').ok, false);
  const longFiles = Array.from({ length: 3 }, (_, index) => attachment(`notes${index}.txt`, 'text/plain', new TextEncoder().encode('字'.repeat(chatAttachmentLimits.maxTextCharacters))));
  assert.equal(validateChatAttachments(longFiles, '').ok, true);
  assert.equal(validateChatAttachments(longFiles, '问').ok, false);
});

test('keeps malformed Unicode and duplicate names out of the validated turn', () => {
  assert.equal(validateChatAttachments([attachment('bad.txt', 'text/plain', Uint8Array.from([0xc3, 0x28]))], '问题').ok, false);
  assert.equal(validateChatAttachments([
    attachment('same.txt', 'text/plain', new TextEncoder().encode('a')),
    attachment('same.txt', 'text/plain', new TextEncoder().encode('b')),
  ], '问题').ok, false);
});

test('accepts attachments only on the current send and raises the request envelope only for bounded files', () => {
  const request = { requestID: '0f000000-0000-4000-8000-000000000001', petID: 'pet-a',
    route: { connectionID: 'connection-a', modelEntryID: 'model-a', fingerprint: 'a'.repeat(64) },
    text: '请检查这份材料', history: [] as { user: string; assistant: string }[],
    attachments: [attachment('guide.pdf', 'application/pdf', pdf)] };
  assert.equal(validOnlineChatInput(request), true);
  assert.equal(validOnlineChatInput({ ...request, attachments: [{ ...request.attachments[0], path: '/tmp/guide.pdf' }] }), false);
  assert.equal(validOnlineChatInput({ ...request, history: [{ user: '旧问题', assistant: '旧回答', attachments: request.attachments }] }), false);
  assert.equal(validOnlineChatInput({ ...request, history: [{ user: '旧问题', assistant: '旧回答' }] }), true);
});
