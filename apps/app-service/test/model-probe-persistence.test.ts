import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { isManagementReply } from '../src/models/management-contract.ts';
import { ModelManagement } from '../src/models/management.ts';
import { configuration } from './fixtures/models.ts';
import { syntheticVault } from './fixtures/secure-models.ts';
import { textReply } from './fixtures/model-replies.ts';

const local = { skip: process.platform === 'win32' };
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pet-probe-records-')));
  const { backend } = syntheticVault();
  let calls = 0, status = 200;
  const fetch: typeof globalThis.fetch = async () => { calls++; return Response.json(status === 200 ? textReply('chat-completions') : { error: 'PRIVATE-UPSTREAM-DETAIL' }, { status }); };
  let models = new ModelManagement(root, backend, undefined, { fetch });
  t.after(async () => { await models.close(); await rm(root, { recursive: true, force: true }); });
  const { revision, credentialRef, ...draft } = configuration('chat-completions').connections[0]!;
  const reply = await models.run('save', { connection: draft, expectedRevision: 0, credential: { kind: 'replace', key: 'SYNTHETIC-PRIVATE-KEY' } });
  assert.ok(reply.ok);
  const saved = reply.configuration.connections[0]!, entry = saved.models[0]!;
  const input = { connectionID: saved.id, expectedRevision: saved.revision, entryID: entry.entryID, modelID: entry.modelID, ...(entry.maxOutputTokens === undefined ? {} : { maxOutputTokens: entry.maxOutputTokens }), ...saved.compatibility, ...entry.compatibility };
  return { root, draft, input, current: () => models, calls: () => calls, setStatus: (value: number) => { status = value; },
    restart: async () => { await models.close(); models = new ModelManagement(root, backend, undefined, { fetch }); } };
}

test('successful probes survive a service restart without changing configuration or calling the provider on reads', local, async t => {
  const f = await fixture(t), before = await f.current().run('list', undefined);
  const result = await f.current().testConnection(f.input);
  assert.ok(result.ok);
  await f.restart();
  const listed = await f.current().run('list', undefined);
  assert.ok(listed.ok && before.ok);
  assert.ok(isManagementReply('list', listed));
  assert.deepEqual(listed.configuration, before.configuration);
  assert.equal(listed.probeResults?.length, 1);
  assert.deepEqual(listed.probeResults![0]!.input, f.input);
  assert.deepEqual(listed.probeResults![0]!.result, result);
  assert.ok(Number.isFinite(Date.parse(listed.probeResults![0]!.testedAt)));
  assert.equal(f.calls(), 1);
  const file = join(f.root, 'model-probes.json');
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(file, 'utf8'), /SYNTHETIC-PRIVATE-KEY|credentialRef|PRIVATE-UPSTREAM-DETAIL/);
});

test('a later failed probe replaces old success, but cancelled tests do not erase the last completed result', local, async t => {
  const f = await fixture(t);
  assert.ok((await f.current().testConnection(f.input)).ok);
  f.setStatus(401);
  assert.deepEqual(await f.current().testConnection(f.input), { version: 1, ok: false, error: 'authentication_failed' });
  assert.deepEqual(await f.current().testConnection(f.input, AbortSignal.abort()), { version: 1, ok: false, error: 'cancelled' });
  await f.restart();
  const listed = await f.current().run('list', undefined); assert.ok(listed.ok);
  assert.equal(listed.probeResults?.length, 1);
  assert.deepEqual(listed.probeResults![0]!.result, { version: 1, ok: false, error: 'authentication_failed' });
  assert.equal(f.calls(), 2);
});

test('saved connection edits invalidate persisted probe evidence after restart', local, async t => {
  const f = await fixture(t);
  assert.ok((await f.current().testConnection(f.input)).ok);
  const updated = await f.current().run('save', { connection: { ...f.draft, baseURL: 'https://changed.invalid/v1' }, expectedRevision: f.input.expectedRevision, credential: { kind: 'remove' } });
  assert.ok(updated.ok);
  await f.restart();
  const listed = await f.current().run('list', undefined); assert.ok(listed.ok);
  assert.deepEqual(listed.probeResults ?? [], []);
  assert.equal(f.calls(), 1);
});

test('corrupt probe storage fails closed before another potentially billed request', local, async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'model-probes.json'), '{invalid', { mode: 0o600 });
  assert.deepEqual(await f.current().testConnection(f.input), { version: 1, ok: false, error: 'storage_unavailable' });
  assert.equal(f.calls(), 0);
});

test('draft model tests retain their own evidence without overwriting the saved model result', local, async t => {
  const f = await fixture(t);
  assert.ok((await f.current().testConnection(f.input)).ok);
  const draft = { ...f.input, modelID: 'unsaved-draft-model' };
  assert.ok((await f.current().testConnection(draft)).ok);
  await f.restart();
  const listed = await f.current().run('list', undefined); assert.ok(listed.ok);
  assert.equal(listed.probeResults?.length, 2);
  assert.deepEqual(listed.probeResults!.map(record => record.input.modelID), [f.input.modelID, draft.modelID]);
});

test('deleting a connection removes its persisted evidence from subsequent reads', local, async t => {
  const f = await fixture(t);
  assert.ok((await f.current().testConnection(f.input)).ok);
  assert.ok((await f.current().run('remove', { connectionID: f.input.connectionID, expectedRevision: f.input.expectedRevision })).ok);
  await f.restart();
  const listed = await f.current().run('list', undefined); assert.ok(listed.ok);
  assert.deepEqual(listed.probeResults ?? [], []);
});

test('an existing probe writer lock rejects a new probe before contacting the provider, without stealing the lock', local, async t => {
  const f = await fixture(t), file = join(f.root, '.model-probes-writer.lock');
  await writeFile(file, '', { mode: 0o600 });
  assert.deepEqual(await f.current().testConnection(f.input), { version: 1, ok: false, error: 'busy' });
  assert.equal(f.calls(), 0);
  assert.ok((await f.current().run('list', undefined)).ok);
  assert.ok((await lstat(file)).isFile());
});

for (const unsafe of ['permissions', 'symlink'] as const) test(`unsafe probe evidence (${unsafe}) is rejected before contacting the provider`, local, async t => {
  const f = await fixture(t), file = join(f.root, 'model-probes.json');
  if (unsafe === 'permissions') {
    await writeFile(file, '{"schemaVersion":1,"records":[]}', { mode: 0o600 });
    await chmod(file, 0o644);
  } else {
    const other = join(f.root, 'unrelated-file');
    await writeFile(other, 'PRIVATE-UNRELATED-CONTENT', { mode: 0o600 });
    await symlink(other, file);
  }
  assert.deepEqual(await f.current().testConnection(f.input), { version: 1, ok: false, error: 'storage_unavailable' });
  assert.equal(f.calls(), 0);
  if (unsafe === 'symlink') assert.equal(await readFile(join(f.root, 'unrelated-file'), 'utf8'), 'PRIVATE-UNRELATED-CONTENT');
});

test('unreadable probe evidence is reported without hiding valid saved model configuration', local, async t => {
  const f = await fixture(t), before = await f.current().run('list', undefined);
  assert.ok(before.ok);
  const options = await f.current().listChatModels();
  const file = join(f.root, 'model-probes.json');
  await writeFile(file, '{invalid', { mode: 0o600 });
  await f.restart();
  const listed = await f.current().run('list', undefined);
  assert.deepEqual(listed, { ...before, probeStorageUnavailable: true });
  assert.ok(isManagementReply('list', listed));
  assert.deepEqual(await f.current().listChatModels(), options);
  assert.deepEqual(await f.current().testConnection(f.input), { version: 1, ok: false, error: 'storage_unavailable' });
  assert.equal(await readFile(file, 'utf8'), '{invalid');
  assert.equal(f.calls(), 0);
});
