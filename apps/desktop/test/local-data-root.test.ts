import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { LocalDataRoot } from '../src/local-data-root.ts';
import { WorkspaceStore } from '../../app-service/src/workspace-store.ts';
import { configuration } from '../../app-service/test/fixtures/models.ts';
import { ModelConfigurationStore } from '../../app-service/src/models/configuration-store.ts';

async function fixture(t: TestContext) {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'pet-local-data-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home'), legacy = join(base, 'electron'), target = join(home, '.adpets');
  await mkdir(home, { mode: 0o700 }); await mkdir(legacy);
  return { home, legacy, target, data: new LocalDataRoot(home, legacy) };
}
const state = { schemaVersion: 1, revision: 9, theme: 'dark', registry: { schemaVersion: 1, instances: [] } } as const;
async function seed(legacy: string) {
  for (const dir of ['workspace', 'models', 'Cache']) await mkdir(join(legacy, dir), { mode: 0o700 });
  const file = join(legacy, 'workspace', 'workspace-state.json');
  await writeFile(file, JSON.stringify(state), { mode: 0o600 });
  const model = configuration();
  model.connections[0]!.credentialRef = `mcred-v1-${'a'.repeat(64)}`;
  await writeFile(join(legacy, 'models', 'model-providers.json'), JSON.stringify(model), { mode: 0o600 });
  await writeFile(join(legacy, 'Cache', 'not-data'), 'ignored');
  return file;
}

test('an empty Electron profile creates a private business root and never falls back after it disappears', { skip: process.platform === 'win32' }, async t => {
  const { data, target, legacy } = await fixture(t);
  await mkdir(join(legacy, 'Cache'));
  const results = await Promise.allSettled([data.select(), data.select()]);
  assert.ok(results.some(result => result.status === 'fulfilled'));
  assert.deepEqual(await data.select(), { kind: 'adpets', root: target });
  for (const dir of ['', 'models', 'workspace', 'live']) assert.equal((await lstat(join(target, dir))).mode & 0o777, 0o700);
  await rm(target, { recursive: true });
  await assert.rejects(data.select());
});

test('explicit migration preserves canonical workspace, model and character files and fences the legacy writers', { skip: process.platform === 'win32' }, async t => {
  const { data, legacy, target } = await fixture(t);
  const file = await seed(legacy);
  const characters = join(legacy, 'workspace', 'characters');
  await mkdir(characters, { mode: 0o700 });
  const character = JSON.stringify({ schemaVersion: 1, petID: 'retired-1', revision: 1, identity: null, identityHistory: [], memories: [], goals: [] }) + '\n';
  await writeFile(join(characters, 'retired-1.json'), character, { mode: 0o600 });
  assert.deepEqual(await data.select(), { kind: 'legacy', root: legacy });
  await data.migrate();
  assert.deepEqual(await data.select(), { kind: 'adpets', root: target });
  assert.equal(await readFile(join(target, 'workspace', 'workspace-state.json'), 'utf8'), await readFile(file, 'utf8'));
  assert.equal(await readFile(join(target, 'workspace', 'characters', 'retired-1.json'), 'utf8'), character);
  assert.equal(await readFile(join(target, 'models', 'model-providers.json'), 'utf8'), await readFile(join(legacy, 'models', 'model-providers.json'), 'utf8'));
  assert.ok(!(await readdir(target)).includes('Cache'));
  await assert.rejects(new WorkspaceStore(join(legacy, 'workspace')).acquire(), { code: 'busy' });
  await assert.rejects(new ModelConfigurationStore(join(legacy, 'models')).acquireOnlineAuthority(), { code: 'busy' });
});

test('a busy legacy writer, a corrupt source or a preexisting target cannot be overwritten', { skip: process.platform === 'win32' }, async t => {
  const { data, legacy, target } = await fixture(t);
  const file = await seed(legacy);
  const writer = new WorkspaceStore(join(legacy, 'workspace'));
  await writer.acquire();
  await assert.rejects(data.migrate());
  await writer.close();
  await writeFile(file, '{bad');
  await assert.rejects(data.migrate());
  assert.equal(await readFile(file, 'utf8'), '{bad');
  assert.deepEqual(await data.select(), { kind: 'legacy', root: legacy });
  await mkdir(target);
  await assert.rejects(data.migrate());
  await assert.rejects(data.select());
});

test('target links and overbroad source permissions are rejected', { skip: process.platform === 'win32' }, async t => {
  const { data, legacy, target } = await fixture(t);
  await symlink(legacy, target);
  await assert.rejects(data.select());
  await rm(target);
  await seed(legacy);
  const statePath = join(legacy, 'workspace', 'workspace-state.json');
  await rm(statePath);
  await writeFile(statePath, JSON.stringify(state), { mode: 0o644 });
  await assert.rejects(data.migrate());
  await assert.rejects(lstat(target), { code: 'ENOENT' });
});

test('known unpublished error rolls back selection; a published receipt can be reopened after acknowledgement is lost', { skip: process.platform === 'win32' }, async t => {
  const { home, legacy, target } = await fixture(t);
  await seed(legacy);
  const unpublished = new LocalDataRoot(home, legacy, async () => { throw Error('not published'); });
  await assert.rejects(unpublished.migrate());
  assert.equal((await unpublished.select()).kind, 'legacy');
  const published = new LocalDataRoot(home, legacy, async (from, to) => { await rename(from, to); throw Error('ack lost'); });
  await assert.rejects(published.migrate());
  assert.deepEqual(await new LocalDataRoot(home, legacy).select(), { kind: 'adpets', root: target });
  await assert.rejects(new WorkspaceStore(join(legacy, 'workspace')).acquire(), { code: 'busy' });
});


test('a concurrent transfer cannot select one of two roots before publication', { skip: process.platform === 'win32' }, async t => {
  const { legacy, home, target, data } = await fixture(t);
  await seed(legacy);
  const entered = deferred<void>(), proceed = deferred<void>();
  const publisher = new LocalDataRoot(home, legacy, async (from, to) => { entered.resolve(); await proceed.promise; await rename(from, to); });
  const moving = publisher.migrate();
  try {
    await entered.promise;
    await assert.rejects(data.select());
    await assert.rejects(data.migrate());
    await assert.rejects(new WorkspaceStore(join(legacy, 'workspace')).acquire(), { code: 'busy' });
  } finally { proceed.resolve(); await moving; }
  assert.deepEqual(await data.select(), { kind: 'adpets', root: target });
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }


test('new business roots reserve private agents and skills directories beside models and workspace', { skip: process.platform === 'win32' }, async t => {
  const { data, target } = await fixture(t);
  await data.select();
  for (const dir of ['agents', 'skills']) {
    const info = await lstat(join(target, dir));
    assert.ok(info.isDirectory());
    assert.equal(info.mode & 0o777, 0o700);
  }
});

test('explicit migration carries validated model probe evidence into the new business root', { skip: process.platform === 'win32' }, async t => {
  const { data, legacy, target } = await fixture(t);
  await seed(legacy);
  const saved = configuration().connections[0]!, entry = saved.models[0]!;
  const bytes = JSON.stringify({ schemaVersion: 1, records: [{
    input: { connectionID: saved.id, expectedRevision: saved.revision, entryID: entry.entryID, modelID: entry.modelID },
    result: { version: 1, ok: true, connectionID: saved.id, revision: saved.revision, entryID: entry.entryID }, testedAt: '2026-11-24T00:00:00.000Z',
  }] });
  await writeFile(join(legacy, 'models', 'model-probes.json'), bytes, { mode: 0o600 });
  await data.migrate();
  assert.equal(await readFile(join(target, 'models', 'model-probes.json'), 'utf8'), bytes);
  assert.equal(await readFile(join(legacy, 'models', 'model-probes.json'), 'utf8'), bytes);
});

test('malformed model probe evidence aborts migration without selecting or deleting a data root', { skip: process.platform === 'win32' }, async t => {
  const { data, legacy, target } = await fixture(t);
  await seed(legacy);
  await writeFile(join(legacy, 'models', 'model-probes.json'), '{invalid', { mode: 0o600 });
  await assert.rejects(data.migrate());
  await assert.rejects(lstat(target), { code: 'ENOENT' });
  assert.equal((await data.select()).kind, 'legacy');
});

test('a damaged optional probe receipt cannot prevent reopening an already migrated root', { skip: process.platform === 'win32' }, async t => {
  const { data, home, legacy, target } = await fixture(t);
  await seed(legacy);
  await data.migrate();
  const receipt = join(target, 'models', 'model-probes.json');
  await writeFile(receipt, '{invalid', { mode: 0o600 });
  assert.deepEqual(await new LocalDataRoot(home, legacy).select(), { kind: 'adpets', root: target });
  assert.equal(await readFile(receipt, 'utf8'), '{invalid');
  await writeFile(join(target, 'models', 'model-providers.json'), '{invalid');
  await assert.rejects(new LocalDataRoot(home, legacy).select());
});
