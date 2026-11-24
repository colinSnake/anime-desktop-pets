import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createChatProject } from '../src/chat-project-directory.ts';

const fixture = async (t: test.TestContext) => {
 const root = await mkdtemp(join(tmpdir(), 'pet-project-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 const registrations: unknown[] = [];
 const deps: Parameters<typeof createChatProject>[1] = {
  eligible: () => true, select: async () => ({ canceled: false, filePaths: [root] }),
  list: async () => ({ ok: true, projects: [] }),
  register: async input => { registrations.push(input); return { ok: true, project: input.project }; },
 };
 return { root, deps, registrations };
};
const input = { petID: 'pet-synthetic', name: '合成项目' };

test('creates only the exact new directory under the native selection and exposes no path', async t => {
 const { root, deps, registrations } = await fixture(t);
 const result = await createChatProject(input, deps);
 assert.ok(result.ok);
 assert.deepEqual(await readdir(root), [input.name]);
 assert.deepEqual(await readdir(join(root, input.name)), []);
 assert.deepEqual(registrations, [{ petID: input.petID, project: result.project }]);
 assert.doesNotMatch(JSON.stringify(result), /[/\\]/);
});

test('rejects incoming paths, preserves existing contents and rejects a stale or cancelled chooser', async t => {
 const { root, deps, registrations } = await fixture(t);
 await mkdir(join(root, input.name)); await writeFile(join(root, input.name, 'keep.txt'), 'keep');
 assert.deepEqual(await createChatProject({ ...input, path: root }, deps), { ok: false, error: 'invalid_request' });
 for (const name of ['../outside', '/absolute', 'a\\b', '.']) assert.deepEqual(await createChatProject({ ...input, name }, deps), { ok: false, error: 'invalid_request' });
 assert.deepEqual(await createChatProject(input, deps), { ok: false, error: 'exists' });
 assert.deepEqual(await readdir(join(root, input.name)), ['keep.txt']);
 let eligible = true;
 const select = async () => { eligible = false; return { canceled: false, filePaths: [root] }; };
 assert.deepEqual(await createChatProject({ ...input, name: '未创建' }, { ...deps, eligible: () => eligible, select }), { ok: false, error: 'cancelled' });
 assert.deepEqual(await readdir(root), [input.name]); assert.deepEqual(registrations, []);
});

test('an unconfirmed registration does not delete the directory', async t => {
 const { root, deps } = await fixture(t);
 const result = await createChatProject(input, { ...deps, register: async () => ({ ok: false, error: 'unavailable' }) });
 assert.deepEqual(result, { ok: false, error: 'unregistered' });
 assert.deepEqual(await readdir(root), [input.name]);
});
