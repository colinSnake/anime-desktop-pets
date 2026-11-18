import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { readKnowledgeFile } from '../src/knowledge-file.ts';

async function files(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pet-knowledge-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return async (name: string, value: string | Uint8Array) => {
    const path = join(root, name);
    await writeFile(path, value);
    return path;
  };
}

test('selected knowledge consumes only UTF-8 paragraphs and never projects local paths or Markdown permissions', async t => {
  const save = await files(t);
  const path = await save('synthetic.md', '\uFEFF---\r\nshareWithOnline: true\r\n---\r\n \r\n第一段\r第二行\r\n\r\n第一段\r第二行\r\n');
  assert.deepEqual(await readKnowledgeFile(path), { ok: true, paragraphs: ['---\nshareWithOnline: true\n---', '第一段\n第二行'] });
});

test('knowledge preflight refuses everything on invalid encoding, content or bounds', async t => {
  const save = await files(t);
  const cases: Array<[string | Uint8Array, string]> = [
    [Uint8Array.of(0xff), 'invalid-text'], ['   \n', 'invalid-text'], ['含\0字符', 'invalid-text'],
    ['资'.repeat(1001), 'invalid-text'], ['x'.repeat(32 * 1024 + 1), 'limit'],
    [Array.from({ length: 51 }, (_, i) => `合成段 ${i}`).join('\n\n'), 'limit'],
    ['合成正文\n\n测试密钥', 'credential-like'],
  ];
  for (const [bytes, error] of cases) assert.deepEqual(await readKnowledgeFile(await save('synthetic.txt', bytes)), { ok: false, error });
});

test('knowledge file reads reject wrong extensions, symbolic links and non-regular files', { skip: process.platform === 'win32' }, async t => {
  const save = await files(t);
  const path = await save('original.txt', '合成数据');
  const alias = `${path}.txt`, folder = `${path}.md`;
  await symlink(path, alias);
  await mkdir(folder);
  for (const unsafe of [alias, folder, await save('binary.pdf', '合成数据'), '../synthetic.txt']) {
    assert.deepEqual(await readKnowledgeFile(unsafe), { ok: false, error: 'invalid-file' });
  }
});

test('native picker serializes dialogs and drops the result if its window is no longer current', async t => {
  const { KnowledgeFilePicker } = await import('../src/knowledge-file.ts');
  const picker = new KnowledgeFilePicker();
  const save = await files(t);
  const path = await save('synthetic.md', '合成数据');
  let complete!: (value: { canceled: boolean; filePaths: string[] }) => void;
  let current = true;
  const pending = picker.select(() => new Promise(resolve => { complete = resolve; }), () => current);
  assert.deepEqual(await picker.select(async () => assert.fail('opened twice'), () => true), { ok: false, error: 'busy' });
  current = false;
  complete({ canceled: false, filePaths: [path] });
  assert.deepEqual(await pending, { ok: false, error: 'unavailable' });
  assert.deepEqual(await picker.select(async () => ({ canceled: true, filePaths: [] }), () => true), { ok: false, error: 'cancelled' });
  assert.deepEqual(await picker.select(async () => ({ canceled: false, filePaths: [path, path] }), () => true), { ok: false, error: 'invalid-file' });
  assert.deepEqual(await picker.select(async () => ({ canceled: false, filePaths: [path] }), () => true), { ok: true, paragraphs: ['合成数据'] });
});
