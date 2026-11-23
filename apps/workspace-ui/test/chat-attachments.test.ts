import assert from 'node:assert/strict';
import test from 'node:test';
import { readAgentTaskFiles, readChatFiles } from '../src/chat-attachments.ts';
import { resetComposerDragState } from '../src/ChatComposer.tsx';

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('reads selected files into path-free bounded current-turn attachment DTOs', async () => {
  const image = new File([png], 'diagram.png', { type: 'image/png' });
  const text = new File([new TextEncoder().encode('要点')], 'notes.md', { type: '' });
  const result = await readChatFiles([image, text], '请看附件');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.attachments.map(file => [file.name, file.mediaType]), [
    ['diagram.png', 'image/png'], ['notes.md', 'text/plain'],
  ]);
  assert.equal(result.attachments[1]!.data, '6KaB54K5');
  assert.doesNotMatch(JSON.stringify(result.attachments), /path|private|tmp/);
});

test('rejects unsupported or oversized selections before reading file bytes', async () => {
  assert.deepEqual(await readChatFiles([new File(['no'], 'run.exe')], '问题'), { ok: false, error: 'unsupported' });
  const tooLarge = { name: 'large.png', type: 'image/png', size: 5 * 1024 * 1024 + 1,
    arrayBuffer: async () => { assert.fail('oversized file must be rejected before read'); } };
  assert.deepEqual(await readChatFiles([tooLarge], '问题'), { ok: false, error: 'limit' });
  assert.deepEqual(await readChatFiles(Array.from({ length: 6 }, (_, index) => new File(['x'], `${index}.txt`)), '问题'), { ok: false, error: 'limit' });
});


test('task picker and drop share an atomic text-only append, with limits and duplicate checks before reading', async () => {
  const used = await readAgentTaskFiles([new File(['old'], 'first.txt')], '', []);
  assert.ok(used.ok);
  const next = await readAgentTaskFiles([new File(['next'], 'second.md')], '', used.attachments);
  assert.ok(next.ok);
  assert.deepEqual(next.attachments.map(item => item.name), ['first.txt', 'second.md']);
  const neverRead = async () => { assert.fail('file must not be read'); };
  assert.deepEqual(await readAgentTaskFiles([{ name: 'FIRST.TXT', type: 'text/plain', size: 1, arrayBuffer: neverRead }], '', used.attachments), { ok: false, error: 'duplicate' });
  assert.deepEqual(await readAgentTaskFiles([{ name: 'diagram.png', type: 'image/png', size: 8, arrayBuffer: neverRead }], '', used.attachments), { ok: false, error: 'unsupported' });
  assert.deepEqual(await readAgentTaskFiles(Array.from({ length: 5 }, (_, i) => new File(['x'], `${i}.txt`)), '', used.attachments), { ok: false, error: 'limit' });
  assert.equal(used.attachments.length, 1);
});


test('visibility cancellation invalidates pending reads and clears an interrupted composer drag', () => {
  const fileRead = { current: 4 };
  const dragDepth = { current: 2 };
  resetComposerDragState(fileRead, dragDepth);
  assert.equal(fileRead.current, 5);
  assert.equal(dragDepth.current, 0);
});
