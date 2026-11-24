import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { AgentStateStore, type AgentSource, type RunStatus } from '../src/agent/agent-state.ts';
import { ModelError } from '../src/models/errors.ts';

const use = { skip: process.platform === 'win32' };
const errorCode = (code: string) => (error: unknown) => error instanceof ModelError && error.code === code && error.message === code && error.cause === undefined;
const request = (petID = 'pet-a', source: AgentSource = 'chat') => ({ requestID: randomUUID(), petID, source });
const definition = (id = 'pet-a') => ({ schemaVersion: 1, id, runtime: 'pi', enabled: true, skills: [] });

async function fixture(t: TestContext) {
  const parent = await mkdtemp(join(await realpath(tmpdir()), 'pet-agent-state-'));
  const root = join(parent, 'state');
  const stores: AgentStateStore[] = [];
  const store = () => { const value = new AgentStateStore(root); stores.push(value); return value; };
  t.after(async () => {
    try { for (const value of stores) await value.close(); }
    finally { await rm(parent, { recursive: true, force: true }); }
  });
  return { parent, root, store, database: join(root, 'agent-state.sqlite'), config: join(root, 'agents', 'pet-a', 'agent.json') };
}

test('creates isolated declarative agents and a private metadata-only ledger', use, async t => {
  const f = await fixture(t), store = f.store();
  await store.ready();
  assert.deepEqual(await store.ensureAgent('pet-a'), definition());
  assert.deepEqual(await store.ensureAgent('pet-b'), definition('pet-b'));
  const first = request();
  await store.begin(first);
  const row = await store.status(first.requestID);
  assert.equal(row?.requestID, first.requestID);
  assert.equal(row?.petID, 'pet-a');
  assert.equal(row?.source, 'chat');
  assert.equal(row?.status, 'running');
  assert.ok(Number.isSafeInteger(row?.startedAt));
  assert.ok(Number.isSafeInteger(row?.updatedAt));
  assert.equal(await store.status(randomUUID()), undefined);
  for (const path of [f.root, join(f.root, 'agents'), join(f.root, 'agents', 'pet-a'), join(f.root, 'agents', 'pet-b')]) {
    assert.equal((await lstat(path)).mode & 0o777, 0o700);
  }
  for (const path of [f.database, f.config, join(f.root, 'agents', 'pet-b', 'agent.json')]) {
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
  }
  assert.deepEqual(JSON.parse(await readFile(f.config, 'utf8')), definition());
  await store.close();
  const db = new DatabaseSync(f.database, { readOnly: true });
  try {
    assert.deepEqual(db.prepare('PRAGMA table_info(runs)').all().map(row => row.name), ['request_id', 'pet_id', 'source', 'status', 'started_at', 'updated_at']);
    assert.equal(db.prepare('SELECT count(*) AS n FROM runs').get()?.n, 1);
  } finally { db.close(); }
});

test('enforces global durable request uniqueness and recovers running requests once on restart', use, async t => {
  const f = await fixture(t), store = f.store(), active = request(), done = request('pet-b', 'task');
  await store.begin(active);
  await store.begin(done);
  await store.finish(done.requestID, 'completed');
  await assert.rejects(store.begin(active), errorCode('invalid_request'));
  await assert.rejects(store.begin({ ...done, petID: 'pet-c' }), errorCode('invalid_request'));
  await store.close();
  const next = f.store();
  await next.ready();
  assert.equal((await next.status(active.requestID))?.status, 'interrupted');
  assert.equal((await next.status(done.requestID))?.status, 'completed');
  await assert.rejects(next.begin(active), errorCode('invalid_request'));
  const current = request();
  await next.begin(current);
  await next.ready();
  assert.equal((await next.status(current.requestID))?.status, 'running');
});

test('serializes concurrent initialization, ensure, begin, duplicate admission and finish', use, async t => {
  const f = await fixture(t), store = f.store();
  const inputs = ['chat', 'voice', 'live', 'task'].map(source => request('pet-a', source as AgentSource));
  await Promise.all([store.ready(), store.ready(), store.ensureAgent('pet-a'), store.ensureAgent('pet-a'), ...inputs.map(input => store.begin(input))]);
  const outcomes = await Promise.allSettled([store.begin(inputs[0]!), store.begin(inputs[0]!)]);
  assert.ok(outcomes.every(result => result.status === 'rejected' && errorCode('invalid_request')(result.reason)));
  const statuses = ['completed', 'failed', 'cancelled', 'interrupted'] as const;
  await Promise.all(inputs.map((input, index) => store.finish(input.requestID, statuses[index]!)));
  for (let index = 0; index < inputs.length; index++) {
    const row = await store.status(inputs[index]!.requestID);
    assert.equal(row?.source, inputs[index]!.source);
    assert.equal(row?.status, statuses[index]);
    assert.ok(row!.updatedAt >= row!.startedAt);
  }
});

test('terminal states are immutable, repeated finish is idempotent and unknown finish is rejected', use, async t => {
  const f = await fixture(t), store = f.store(), input = request();
  await store.begin(input);
  await store.finish(input.requestID, 'cancelled');
  const previous = await store.status(input.requestID);
  await store.finish(input.requestID, 'cancelled');
  assert.deepEqual(await store.status(input.requestID), previous);
  await assert.rejects(store.finish(input.requestID, 'completed'), errorCode('invalid_request'));
  await assert.rejects(store.finish(randomUUID(), 'completed'), errorCode('invalid_request'));
  await assert.rejects(store.finish(input.requestID, 'running' as Exclude<RunStatus, 'running'>), errorCode('invalid_request'));
});

test('close drains accepted operations, is idempotent and never reopens during initialization', use, async t => {
  const f = await fixture(t), store = f.store(), input = request();
  const accepted = [store.ready(), store.ensureAgent('pet-a'), store.begin(input), store.finish(input.requestID, 'completed')];
  const closing = store.close();
  const rejected = [store.ready(), store.ensureAgent('pet-b'), store.begin(request()), store.status(input.requestID), store.finish(input.requestID, 'failed')];
  await Promise.all(rejected.map(result => assert.rejects(result, errorCode('closed'))));
  await Promise.all([...accepted, closing, store.close()]);
  assert.equal((await f.store().status(input.requestID))?.status, 'completed');
});

test('closing an unused store does not create directories or a database', use, async t => {
  const f = await fixture(t), store = f.store();
  await store.close();
  await store.close();
  await assert.rejects(lstat(f.root), { code: 'ENOENT' });
  await assert.rejects(store.ready(), errorCode('closed'));
});

test('validates contract UUIDs, pet IDs and sources without persisting input payloads', use, async t => {
  const f = await fixture(t), store = f.store();
  for (const requestID of ['plain-id', randomUUID().toUpperCase(), '../escape', '', 'a'.repeat(200)]) {
    await assert.rejects(store.begin({ ...request(), requestID }), errorCode('invalid_request'));
    await assert.rejects(store.status(requestID), errorCode('invalid_request'));
    await assert.rejects(store.finish(requestID, 'failed'), errorCode('invalid_request'));
  }
  for (const petID of ['../outside', 'Pet-A', '', 'a'.repeat(65), 'pet_a']) {
    await assert.rejects(store.ensureAgent(petID), errorCode('invalid_request'));
    await assert.rejects(store.begin(request(petID)), errorCode('invalid_request'));
  }
  await assert.rejects(store.begin({ ...request(), source: 'unknown' as AgentSource }), errorCode('invalid_request'));
  await assert.rejects(store.begin({ ...request(), text: 'never-persist-this-body' } as ReturnType<typeof request>), errorCode('invalid_request'));
  const valid = request('a'.repeat(64));
  await store.begin(valid);
  assert.equal((await store.status(valid.requestID))?.petID, valid.petID);
  assert.ok(!(await readFile(f.database)).includes(Buffer.from('never-persist-this-body')));
});

for (const [label, content] of [
  ['invalid JSON', '{private-body'],
  ['unknown schema', JSON.stringify({ ...definition(), schemaVersion: 2 })],
  ['wrong identity', JSON.stringify(definition('pet-b'))],
  ['unknown runtime', JSON.stringify({ ...definition(), runtime: 'dsh' })],
  ['disabled agent', JSON.stringify({ ...definition(), enabled: false })],
  ['unapproved skills', JSON.stringify({ ...definition(), skills: ['shell'] })],
  ['unknown capability', JSON.stringify({ ...definition(), tools: ['shell'] })],
  ['missing field', JSON.stringify({ schemaVersion: 1, id: 'pet-a', runtime: 'pi', enabled: true })],
  ['oversized config', ' '.repeat(4097)],
] as const) {
  test(`rejects ${label} without overwriting or exposing stored content`, use, async t => {
    const f = await fixture(t), store = f.store();
    await store.ensureAgent('pet-a');
    await writeFile(f.config, content);
    await assert.rejects(store.ensureAgent('pet-a'), errorCode('storage_unavailable'));
    await assert.rejects(store.begin(request()), errorCode('storage_unavailable'));
    assert.equal(await readFile(f.config, 'utf8'), content);
  });
}

for (const target of ['root', 'ancestor', 'agents', 'pet', 'config', 'database', 'journal', 'wal', 'shm'] as const) {
  test(`refuses ${target} symbolic links without touching their target`, use, async t => {
    const f = await fixture(t);
    await mkdir(f.root, { mode: 0o700 });
    const outside = join(f.parent, 'outside');
    const isDirectory = ['root', 'ancestor', 'agents', 'pet'].includes(target);
    if (isDirectory) await mkdir(outside, { mode: 0o700 });
    else await writeFile(outside, 'private-target-unchanged', { mode: 0o600 });
    let root = f.root;
    if (target === 'root') { await rm(f.root, { recursive: true }); await symlink(outside, f.root); }
    else if (target === 'ancestor') { await symlink(outside, join(f.root, 'alias')); root = join(f.root, 'alias', 'state'); }
    else if (target === 'agents') await symlink(outside, join(f.root, 'agents'));
    else if (target === 'pet' || target === 'config') {
      await mkdir(join(f.root, 'agents'), { mode: 0o700 });
      if (target === 'pet') await symlink(outside, join(f.root, 'agents', 'pet-a'));
      else { await mkdir(join(f.root, 'agents', 'pet-a'), { mode: 0o700 }); await symlink(outside, f.config); }
    } else await symlink(outside, `${f.database}${target === 'database' ? '' : `-${target}`}`);
    const store = root === f.root ? f.store() : new AgentStateStore(root);
    try { await assert.rejects(store.begin(request()), errorCode('storage_unavailable')); }
    finally { await store.close(); }
    if (!isDirectory) assert.equal(await readFile(outside, 'utf8'), 'private-target-unchanged');
    else assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(outside)), []);
  });
}

for (const target of ['root', 'agents', 'pet', 'config', 'database'] as const) {
  test(`rejects insecure ${target} permissions after initialization`, use, async t => {
    const f = await fixture(t), store = f.store();
    await store.ensureAgent('pet-a');
    const path = { root: f.root, agents: join(f.root, 'agents'), pet: join(f.root, 'agents', 'pet-a'), config: f.config, database: f.database }[target];
    await chmod(path, target === 'config' || target === 'database' ? 0o644 : 0o755);
    await assert.rejects(store.begin(request()), errorCode('storage_unavailable'));
  });
}

for (const target of ['config', 'database'] as const) {
  test(`refuses hard-linked ${target} files`, use, async t => {
    const f = await fixture(t), store = f.store();
    await store.ensureAgent('pet-a');
    await link(target === 'config' ? f.config : f.database, join(f.parent, 'linked'));
    await assert.rejects(store.begin(request()), errorCode('storage_unavailable'));
  });
}

for (const target of ['root', 'agents', 'pet', 'database'] as const) {
  test(`pins ${target} identity and refuses replacement after initialization`, use, async t => {
    const f = await fixture(t), store = f.store();
    await store.ensureAgent('pet-a');
    const path = { root: f.root, agents: join(f.root, 'agents'), pet: join(f.root, 'agents', 'pet-a'), database: f.database }[target];
    await rename(path, `${path}-original`);
    if (target === 'database') await writeFile(path, '', { mode: 0o600 });
    else await mkdir(path, { mode: 0o700 });
    await assert.rejects(store.begin(request()), errorCode('storage_unavailable'));
  });
}

test('does not recreate a removed initialized database or expose raw SQLite errors', use, async t => {
  const f = await fixture(t), store = f.store();
  await store.ready();
  await rm(f.database);
  await assert.rejects(store.ready(), errorCode('storage_unavailable'));
  await assert.rejects(lstat(f.database), { code: 'ENOENT' });
  await store.close();
  await writeFile(f.database, 'synthetic-secret-invalid-database', { mode: 0o600 });
  await assert.rejects(f.store().ready(), errorCode('storage_unavailable'));
});

test('rejects foreign SQLite schemas and pre-existing WAL sidecars', use, async t => {
  const f = await fixture(t);
  await mkdir(f.root, { mode: 0o700 });
  await writeFile(f.database, '', { mode: 0o600 });
  const db = new DatabaseSync(f.database);
  db.exec('CREATE TABLE unknown(secret TEXT); PRAGMA user_version=99');
  db.close();
  await assert.rejects(f.store().ready(), errorCode('storage_unavailable'));
  await rm(f.database);
  await writeFile(`${f.database}-wal`, '', { mode: 0o600 });
  await assert.rejects(f.store().ready(), errorCode('storage_unavailable'));
});

test('snapshots validated admission metadata before queuing async work', use, async t => {
  const f = await fixture(t), store = f.store(), input = request();
  const original = { ...input };
  const admitted = store.begin(input);
  input.requestID = randomUUID();
  input.petID = '../escape';
  input.source = 'live';
  await admitted;
  assert.equal((await store.status(original.requestID))?.source, original.source);
  assert.equal(await store.status(input.requestID), undefined);
});

test('rejects a second owner without interrupting the active owner or leaking the ownership slot', use, async t => {
  const f = await fixture(t), store = f.store(), second = f.store(), input = request();
  await Promise.all([store.ready(), store.begin(input)]);
  await assert.rejects(second.ready(), errorCode('storage_unavailable'));
  assert.equal((await store.status(input.requestID))?.status, 'running');
  await store.close();
  await second.ready();
  assert.equal((await second.status(input.requestID))?.status, 'interrupted');
});

test('SQLite burst contention is storage failure, not duplicate or a raw database error', use, async t => {
  const f = await fixture(t), store = f.store(), input = request(), next = request();
  await store.begin(input);
  const other = new DatabaseSync(f.database);
  try {
    other.exec('BEGIN IMMEDIATE');
    await assert.rejects(store.begin(next), errorCode('storage_unavailable'));
    await assert.rejects(store.finish(input.requestID, 'failed'), errorCode('storage_unavailable'));
    other.exec('ROLLBACK');
  } finally { other.close(); }
  assert.equal(await store.status(next.requestID), undefined);
  await store.begin(next);
  await store.finish(input.requestID, 'failed');
});

test('honors duplicate admission even when the second pet cannot load its config', use, async t => {
  const f = await fixture(t), store = f.store(), input = request();
  await store.begin(input);
  await store.ensureAgent('pet-b');
  await writeFile(join(f.root, 'agents', 'pet-b', 'agent.json'), 'private malformed input');
  await assert.rejects(store.begin({ ...input, petID: 'pet-b' }), errorCode('invalid_request'));
  assert.equal((await store.status(input.requestID))?.petID, 'pet-a');
});

test('exactly one racing store owns startup and recovery on a fresh root', use, async t => {
  const f = await fixture(t);
  const stores = [f.store(), f.store()];
  const booted = await Promise.allSettled(stores.map(store => store.ready()));
  assert.equal(booted.filter(result => result.status === 'fulfilled').length, 1);
  const winnerIndex = booted.findIndex(result => result.status === 'fulfilled');
  const winner = stores[winnerIndex]!, loser = stores[1 - winnerIndex]!;
  const rejected = booted[1 - winnerIndex]!;
  assert.ok(rejected.status === 'rejected' && errorCode('storage_unavailable')(rejected.reason));
  const input = request('pet-a', 'voice');
  await winner.begin(input);
  await assert.rejects(loser.status(input.requestID), errorCode('storage_unavailable'));
  assert.equal((await winner.status(input.requestID))?.status, 'running');
  await winner.close();
  assert.equal((await loser.status(input.requestID))?.status, 'interrupted');
});

test('failed startup releases the in-process ownership claim', use, async t => {
  const f = await fixture(t);
  await mkdir(f.root, { mode: 0o700 });
  await writeFile(`${f.database}-shm`, '', { mode: 0o600 });
  const failed = f.store();
  await assert.rejects(failed.ready(), errorCode('storage_unavailable'));
  await rm(`${f.database}-shm`);
  const running = f.store();
  await running.ready();
  await failed.close();
  const input = request();
  await running.begin(input);
  await assert.rejects(f.store().ready(), errorCode('storage_unavailable'));
  assert.equal((await running.status(input.requestID))?.status, 'running');
});
