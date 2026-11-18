import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { describe } from 'node:test';
import { ModelConfigurationStore } from '../src/models/configuration-store.ts';
import { ModelError } from '../src/models/errors.ts';
import { configuration as modelFixture } from './fixtures/models.ts';

// The protocol fixture accepts generic references; disk storage accepts only vault references.
const configuration = () => {
  const state = modelFixture();
  state.connections[0]!.credentialRef = `mcred-v1-${'a'.repeat(64)}`;
  return state;
};
const code = (expected: string) => (e: unknown) => e instanceof ModelError && e.message === expected && !('cause' in e);
const empty = () => ({ schemaVersion: 2 as const, revision: 0, defaultConnectionID: null, connections: [] });
async function fixture(t: test.TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pet-model-store-'))); t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'models'); return { base, root, file: join(root, 'model-providers.json'), store: new ModelConfigurationStore(root) };
}
describe('POSIX private model storage', { skip: process.platform === 'win32' }, () => {
test('only absent new configuration is empty; roundtrip uses private mode and preserves v2 defaults and stable IDs', async t => {
  const { root, file, store } = await fixture(t); assert.deepEqual(await store.read(), empty());
  const saved = await store.commit(0, () => configuration()); assert.equal(saved.configuration.revision, 1); assert.equal(saved.durability, 'confirmed');
  assert.deepEqual(await new ModelConfigurationStore(root).read(), configuration());
  assert.equal((await lstat(root)).mode & 0o777, 0o700); assert.equal((await lstat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(root)).sort(), ['model-providers.json']);
});
for (const [name, body] of [['bad-json', '{broken'], ['unknown-version', JSON.stringify({ ...empty(), schemaVersion: 99 })], ['invalid-schema', JSON.stringify({ ...empty(), defaultConnectionID: 'absent' })], ['invalid-utf8', Buffer.from([0xff])], ['oversize', ' '.repeat(1_048_577)]] as const) test(`${name}: read and commit refuse to replace protected content`, async t => {
  const { file, store } = await fixture(t); await store.read(); await writeFile(file, body, { mode: 0o600 });
  await assert.rejects(store.read(), code('storage_unavailable')); await assert.rejects(store.commit(0, () => configuration()), code('storage_unavailable'));
  assert.deepEqual(await readFile(file), Buffer.from(body));
});
for (const kind of ['symlink-file', 'hardlink-file', 'directory-file', 'public-file', 'public-root', 'symlink-root', 'symlink-ancestor'] as const) test(`${kind}: refuses insecure paths without changing the target`, async t => {
  const { root, base, file, store } = await fixture(t); const outside = join(base, 'outside'); await writeFile(outside, 'UNTOUCHED', { mode: 0o600 });
  if (kind === 'symlink-root' || kind === 'symlink-ancestor') {
    const target = join(base, 'target'); await mkdir(target, { mode: 0o700 }); await symlink(target, root);
    const s = new ModelConfigurationStore(kind === 'symlink-root' ? root : join(root, 'nested'));
    await assert.rejects(s.read(), code('storage_unavailable')); await assert.rejects(s.commit(0, () => configuration()), code('storage_unavailable'));
  } else {
    await store.read();
    if (kind === 'symlink-file') await symlink(outside, file);
    if (kind === 'hardlink-file') await link(outside, file);
    if (kind === 'directory-file') await mkdir(file);
    if (kind === 'public-file') { await writeFile(file, JSON.stringify(empty()), { mode: 0o600 }); await chmod(file, 0o644); }
    if (kind === 'public-root') await chmod(root, 0o755);
    await assert.rejects(store.read(), code('storage_unavailable')); await assert.rejects(store.commit(0, () => configuration()), code('storage_unavailable'));
  }
  assert.equal(await readFile(outside, 'utf8'), 'UNTOUCHED');
});
test('commits serialize in one store and enforce root revision; a stale commit never overwrites a newer one', async t => {
  const { store } = await fixture(t);
  const results = await Promise.allSettled([store.commit(0, () => configuration()), store.commit(0, () => configuration())]);
  assert.equal(results[0]!.status, 'fulfilled'); assert.equal(results[1]!.status, 'rejected');
  if (results[1]!.status === 'rejected') assert.ok(code('configuration_conflict')(results[1]!.reason));
  const next = await store.commit(1, state => ({ ...state, defaultConnectionID: null })); assert.equal(next.configuration.revision, 2);
  await assert.rejects(store.commit(2, () => ({ ...configuration(), connections: Array(33).fill(configuration().connections[0]) })), code('invalid_configuration'));
  assert.equal((await store.read()).revision, 2);
});
test('another store cannot publish while a short writer lock is held; failures preserve old file and release the lock', async t => {
  const { root, file, store } = await fixture(t); await store.commit(0, () => configuration());
  let release!: () => void, entered!: () => void; const started = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  const blocked = new ModelConfigurationStore(root, { rename: async () => { entered(); await gate; throw Error('PRIVATE SECRET PATH'); } });
  const old = await readFile(file); const pending = assert.rejects(blocked.commit(1, s => ({ ...s, defaultConnectionID: null })), code('storage_unavailable')); await started;
  await assert.rejects(new ModelConfigurationStore(root).commit(1, s => s), code('busy'));
  assert.deepEqual(await store.read(), configuration()); release(); await pending;
  assert.deepEqual(await readFile(file), old); assert.deepEqual((await readdir(root)).sort(), ['model-providers.json']);
  await store.commit(1, s => ({ ...s, defaultConnectionID: null }));
});
test('residual or hostile lock is never stolen or removed', async t => {
  const { root, store } = await fixture(t); await store.read(); const lock = join(root, '.models-writer.lock'); await writeFile(lock, 'other writer', { mode: 0o600 });
  await assert.rejects(store.commit(0, () => configuration()), code('busy')); assert.equal(await readFile(lock, 'utf8'), 'other writer');
});
test('replacement of an acquired directory is rejected; read failures cannot initialize a fresh store', async t => {
  const { base, root, store } = await fixture(t); await store.read(); await rename(root, join(base, 'old')); await mkdir(root, { mode: 0o700 });
  await assert.rejects(store.read(), code('storage_unavailable')); await assert.rejects(store.commit(0, () => configuration()), code('storage_unavailable'));
});
test('rename is the publication point; a directory sync failure reports uncertainty without misreporting an uncommitted rollback', async t => {
  const { root, store } = await fixture(t); await store.read();
  const uncertain = new ModelConfigurationStore(root, { syncDirectory: async () => { throw Error('PRIVATE'); } });
  const result = await uncertain.commit(0, () => configuration()); assert.equal(result.durability, 'unconfirmed'); assert.deepEqual(await store.read(), configuration());
});
test('disappearance of a previously observed config is protected instead of silently reinitializing an empty store', async t => {
  const { file, store } = await fixture(t); await store.commit(0, () => configuration()); await rm(file);
  await assert.rejects(store.read(), code('storage_unavailable')); await assert.rejects(store.commit(0, () => configuration()), code('storage_unavailable'));
});
test('an invalid first read remains protected after the damaged file disappears', async t => {
  const { file, store } = await fixture(t); await store.read(); await writeFile(file, '{bad', { mode: 0o600 });
  await assert.rejects(store.read(), code('storage_unavailable')); await rm(file);
  await assert.rejects(store.commit(0, () => configuration()), code('storage_unavailable'));
});
for (const failure of ['oversize', 'permissions'] as const) test(`a failed ${failure} read cannot become empty after the protected file disappears`, async t => {
  const { file, store } = await fixture(t); await store.read();
  await writeFile(file, failure === 'oversize' ? ' '.repeat(1_048_577) : '{}', { mode: 0o600 });
  if (failure === 'permissions') await chmod(file, 0o644);
  await assert.rejects(store.read(), code('storage_unavailable')); await rm(file);
  await assert.rejects(store.commit(0, () => configuration()), code('storage_unavailable'));
});
test('disk storage rejects values outside the vault reference namespace on read and commit', async t => {
  const { file, store } = await fixture(t); await store.read();
  const invalid = modelFixture(); invalid.connections[0]!.credentialRef = 'SYNTHETIC-KEY';
  await assert.rejects(store.commit(0, () => invalid), code('invalid_configuration'));
  const contents = JSON.stringify(invalid); await writeFile(file, contents, { mode: 0o600 });
  await assert.rejects(store.read(), code('storage_unavailable'));
  assert.equal(await readFile(file, 'utf8'), contents);
});
test('persisted connection revisions cannot exceed the global publication sequence', async t => {
  const { file, store } = await fixture(t); await store.read(); const value = configuration(); value.connections[0]!.revision = 100;
  await writeFile(file, JSON.stringify(value), { mode: 0o600 }); await assert.rejects(store.read(), code('storage_unavailable'));
  await assert.rejects(store.commit(1, () => configuration()), code('storage_unavailable')); assert.equal(JSON.parse(await readFile(file, 'utf8')).connections[0].revision, 100);
});
test('restrictive umask cannot publish an unreadable replacement', { concurrency: false }, async t => {
  const { store, file } = await fixture(t); await store.commit(0, () => configuration()); const previous = process.umask(0o277);
  try { await store.commit(1, s => ({ ...s, defaultConnectionID: null })); }
  finally { process.umask(previous); }
  assert.equal((await lstat(file)).mode & 0o777, 0o600); assert.equal((await store.read()).revision, 2);
});
if (process.platform === 'darwin') for (const target of ['directory', 'file'] as const) test(`macOS permissive ${target} ACL cannot be mistaken for private mode bits`, async t => {
  const { store, root, file } = await fixture(t); await store.commit(0, () => configuration());
  const { promisify } = await import('node:util'), { execFile } = await import('node:child_process');
  const path = target === 'directory' ? root : file; await promisify(execFile)('/bin/chmod', ['+a', 'everyone allow read', path]);
  await assert.rejects(store.read(), code('storage_unavailable')); await assert.rejects(store.commit(1, s => s), code('storage_unavailable'));
});

});

if (process.platform === 'win32') test('Windows storage remains blocked without a trusted ACL verifier', async () => {
  await assert.rejects(new ModelConfigurationStore(join(tmpdir(), 'pet-model-private')).read(), code('storage_unavailable'));
});
