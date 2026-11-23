import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { describe } from 'node:test';
import { CredentialVault } from '../src/models/credentials.ts';
import { ModelConfigurationStore } from '../src/models/configuration-store.ts';
import { ModelRepository, type ConnectionDraft } from '../src/models/repository.ts';
import { ModelError } from '../src/models/errors.ts';
import { resolveRoute } from '../src/models/config.ts';
import { configuration } from './fixtures/models.ts';
import { syntheticVault } from './fixtures/secure-models.ts';
import { textReply } from './fixtures/model-replies.ts';
const code = (expected: string) => (e: unknown) => e instanceof ModelError && e.code === expected && e.message === expected && !('cause' in e);
const draft = (id = 'a'): ConnectionDraft => { const { credentialRef: _ref, revision: _rev, ...c } = configuration().connections[0]!; return { ...c, id }; };
const input = { messages: [{ role: 'user' as const, text: '合成问题' }] };
const reply = () => new Response(JSON.stringify(textReply('chat-completions')), { headers: { 'content-type': 'application/json' } });
const deferred = <T>() => { let resolve!: (x: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; };
async function fixture(t: test.TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pet-model-repository-'))); t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'models'), store = new ModelConfigurationStore(root), secure = syntheticVault(), vault = new CredentialVault(secure.backend);
  const repository = await ModelRepository.open(store, vault); t.after(() => repository.close());
  return { base, root, store, secure, vault, repository };
}
describe('POSIX model repository', { skip: process.platform === 'win32' }, () => {
test('a Key-optional configuration persists without vault access and dispatches without authentication', async t => {
  const { repository, secure, store } = await fixture(t); let calls = 0;
  await repository.saveConnection(draft(), 0); await repository.setDefault(1, 'a', 'entry-one');
  assert.equal(secure.items.size, 0); assert.equal((await store.read()).connections[0]!.credentialRef, undefined);
  const client = await repository.createClient({ fetch: async (_url, init) => { calls++; assert.equal(new Headers(init?.headers).has('authorization'), false); return reply(); } });
  await client.complete(undefined, 'text-chat', input); assert.equal(calls, 1);
});
test('independent keys, two explicit default layers, stable model IDs and route fingerprints survive repository reopen', async t => {
  const { repository, secure, store, root } = await fixture(t);
  await repository.saveConnection(draft('a'), 0, { kind: 'replace', key: 'SYNTHETIC-A' });
  await repository.saveConnection(draft('b'), 0, { kind: 'replace', key: 'SYNTHETIC-B' });
  assert.equal(repository.snapshot().defaultConnectionID, null); await repository.setDefault(2, 'a', 'entry-one');
  const selected = resolveRoute(repository.snapshot(), undefined, 'text-chat');
  const renamed = draft('a'); renamed.displayName = '改名'; renamed.models[0]!.displayName = '同一模型';
  await repository.saveConnection(renamed, 1); assert.equal(resolveRoute(repository.snapshot(), selected, 'text-chat').fingerprint, selected.fingerprint);
  const reopened = await ModelRepository.open(new ModelConfigurationStore(root), new CredentialVault(secure.backend)); t.after(() => reopened.close());
  assert.deepEqual(reopened.snapshot(), await store.read());
  const keys: string[] = [], client = await reopened.createClient({ fetch: async (_url, init) => { keys.push(new Headers(init?.headers).get('authorization')!); return reply(); } });
  await client.complete(undefined, 'text-chat', input); await reopened.setDefault(4, 'b', 'entry-one'); await client.complete(undefined, 'text-chat', input);
  assert.deepEqual(keys, ['Bearer SYNTHETIC-A', 'Bearer SYNTHETIC-B']);
  assert.doesNotMatch(await readFile(join(root, 'model-providers.json'), 'utf8'), /SYNTHETIC|"key"/);
});
test('replacement publishes a fresh version, old selected route is invalidated, and old credential remains readable', async t => {
  const { repository, vault, secure } = await fixture(t); await repository.saveConnection(draft(), 0, { kind: 'replace', key: 'SYNTHETIC-OLD' }); await repository.setDefault(1, 'a', 'entry-one');
  const old = resolveRoute(repository.snapshot(), undefined, 'text-chat');
  await repository.saveConnection(draft(), 1, { kind: 'replace', key: 'SYNTHETIC-NEW' });
  const current = resolveRoute(repository.snapshot(), undefined, 'text-chat'); assert.notEqual(old.credentialRef, current.credentialRef); assert.equal(secure.items.size, 2);
  assert.equal(await vault.read(old.credentialRef!, new AbortController().signal), 'SYNTHETIC-OLD');
  assert.throws(() => resolveRoute(repository.snapshot(), old, 'text-chat'), code('route_changed'));
  await repository.saveConnection(draft(), 3, { kind: 'remove' }); assert.equal(repository.snapshot().connections[0]!.credentialRef, undefined); assert.equal(secure.items.size, 2);
});
test('key preparation failure never publishes configuration or changes old credential', async t => {
  const { repository, store, secure } = await fixture(t); await repository.saveConnection(draft(), 0, { kind: 'replace', key: 'SYNTHETIC-OLD' }); const old = await store.read(); secure.failures.create = true;
  await assert.rejects(repository.saveConnection(draft(), 1, { kind: 'replace', key: 'SYNTHETIC-NEW' }), code('credentials_unavailable'));
  assert.deepEqual(repository.snapshot(), old); assert.deepEqual(await store.read(), old); assert.equal(secure.items.size, 1);
});
for (const cleanupFails of [false, true]) test(`configuration failure retains old version; new unreferenced cleanup failure=${cleanupFails} is explicit`, async t => {
  const { repository, root, store, secure, vault } = await fixture(t); await repository.saveConnection(draft(), 0, { kind: 'replace', key: 'SYNTHETIC-OLD' });
  const failing = await ModelRepository.open(new ModelConfigurationStore(root, { rename: async () => { throw Error('SECRET PATH'); } }), vault); t.after(() => failing.close());
  const old = await store.read(); secure.failures.remove = cleanupFails;
  await assert.rejects(failing.saveConnection(draft(), 1, { kind: 'replace', key: 'SYNTHETIC-NEW' }), e => code('storage_unavailable')(e) && (e as { credentialCleanup?: string }).credentialCleanup === (cleanupFails ? 'pending' : 'removed'));
  assert.deepEqual(await store.read(), old); assert.deepEqual(failing.snapshot(), old); assert.equal(secure.items.size, cleanupFails ? 2 : 1);
});
test('different connections merge under the lock; stale edits of the same connection cannot overwrite or leak a newly prepared key', async t => {
  const { repository, root, secure, vault } = await fixture(t);
  await repository.saveConnection(draft('a'), 0); await repository.saveConnection(draft('b'), 0);
  const other = await ModelRepository.open(new ModelConfigurationStore(root), vault); t.after(() => other.close());
  await repository.saveConnection({ ...draft('a'), displayName: 'A1' }, 1);
  await other.saveConnection({ ...draft('b'), displayName: 'B1' }, 2);
  assert.deepEqual(other.snapshot().connections.map(c => c.displayName), ['A1', 'B1']); assert.equal(other.snapshot().revision, 4);
  await assert.rejects(other.saveConnection(draft('a'), 1, { kind: 'replace', key: 'SYNTHETIC-STALE' }), code('configuration_conflict')); assert.equal(secure.items.size, 0);
});
test('a connection changed during key preparation conflicts after preparation without holding the disk lock', async t => {
  const { repository, root, secure, store } = await fixture(t); await repository.saveConnection(draft(), 0);
  const entered = deferred<void>(), gate = deferred<void>();
  const vault = new CredentialVault({ ...secure.backend, async create(service, ref, value) { entered.resolve(); await gate.promise; await secure.backend.create(service, ref, value); } });
  const waiting = await ModelRepository.open(new ModelConfigurationStore(root), vault); t.after(() => waiting.close());
  const pending = assert.rejects(waiting.saveConnection(draft(), 1, { kind: 'replace', key: 'SYNTHETIC-LATE' }), code('configuration_conflict')); await entered.promise;
  await repository.saveConnection({ ...draft(), displayName: 'NEW' }, 1); gate.resolve(); await pending;
  assert.equal((await store.read()).connections[0]!.displayName, 'NEW'); assert.equal(secure.items.size, 0);
});
test('invalid drafts and arbitrary credentialRef rebinding fail before secure-store work; caller mutations do not affect a queued save', async t => {
  const { repository, secure } = await fixture(t);
  await assert.rejects(repository.saveConnection({ ...draft(), credentialRef: 'stolen' } as ConnectionDraft, 0, { kind: 'replace', key: 'SYNTHETIC' }), code('invalid_configuration'));
  await assert.rejects(repository.saveConnection({ ...draft(), models: [] }, 0, { kind: 'replace', key: 'SYNTHETIC' }), code('invalid_configuration'));
  assert.equal(secure.items.size, 0);
  const original = draft(); const pending = repository.saveConnection(original, 0); original.displayName = 'MUTATED'; await pending;
  assert.equal(repository.snapshot().connections[0]!.displayName, '合成连接'); const leaked = repository.snapshot(); leaked.connections.length = 0; assert.equal(repository.snapshot().connections.length, 1);
});
test('deleting a global default requires an explicit replacement; clearing and both default layers commit atomically', async t => {
  const { repository, store } = await fixture(t); await repository.saveConnection(draft('a'), 0); await repository.saveConnection(draft('b'), 0); await repository.setDefault(2, 'a', 'entry-one');
  await assert.rejects(repository.removeConnection('a', 1, undefined), code('invalid_configuration'));
  await assert.rejects(repository.removeConnection('a', 1, 'absent'), code('invalid_configuration'));
  assert.equal((await store.read()).defaultConnectionID, 'a'); await repository.removeConnection('a', 1, 'b'); assert.equal(repository.snapshot().defaultConnectionID, 'b');
  const before = repository.snapshot(); await assert.rejects(repository.setDefault(before.revision, 'b', 'absent'), code('invalid_configuration')); assert.deepEqual(repository.snapshot(), before);
  await repository.removeConnection('b', 2, null); assert.equal(repository.snapshot().defaultConnectionID, null); assert.equal(repository.snapshot().connections.length, 0);
});
test('old legacy files are never imported; corruption after open cannot be overwritten by a cached snapshot', async t => {
  const { repository, base, root, secure } = await fixture(t); await mkdir(join(base, 'legacy')); await writeFile(join(base, 'legacy/model-provider.json'), 'PRIVATE OLD DATA');
  assert.equal(repository.snapshot().connections.length, 0); await writeFile(join(root, 'model-providers.json'), '{bad', { mode: 0o600 });
  await assert.rejects(repository.saveConnection(draft(), 0, { kind: 'replace', key: 'SYNTHETIC' }), code('storage_unavailable'));
  assert.equal(await readFile(join(root, 'model-providers.json'), 'utf8'), '{bad'); assert.equal(secure.items.size, 0);
  assert.equal(await readFile(join(base, 'legacy/model-provider.json'), 'utf8'), 'PRIVATE OLD DATA');
});
for (const stage of ['credential', 'request', 'discovery'] as const) test(`deletion revokes ${stage} before late results; recreating the same ID cannot revive an old operation`, async t => {
  const { repository, secure, root } = await fixture(t); await repository.saveConnection(draft(), 0, { kind: 'replace', key: 'SYNTHETIC-OLD' }); await repository.setDefault(1, 'a', 'entry-one');
  const entered = deferred<void>(), key = deferred<string | undefined>(), network = deferred<Response>(); let calls = 0;
  const vault = new CredentialVault({ ...secure.backend, read: async (service, ref) => { if (stage === 'credential') { entered.resolve(); return key.promise; } return secure.backend.read(service, ref); } });
  const owned = await ModelRepository.open(new ModelConfigurationStore(root), vault); t.after(() => owned.close());
  const client = await owned.createClient({ fetch: async () => { calls++; entered.resolve(); return network.promise; } });
  const pending = stage === 'discovery' ? client.discover('a') : client.complete(undefined, 'text-chat', input);
  const rejected = assert.rejects(pending, code('route_changed')); await entered.promise;
  await owned.removeConnection('a', 1, null); await rejected;
  await owned.saveConnection(draft(), 0, { kind: 'replace', key: 'SYNTHETIC-NEW' });
  key.resolve(secure.items.values().next().value); network.resolve(reply()); await new Promise(r => setImmediate(r)); assert.equal(calls, stage === 'credential' ? 0 : 1);
  await assert.rejects(client.complete(undefined, 'text-chat', input), code('not_configured'));
});
test('ordinary save leaves an in-flight request pinned to its original credential while a later request uses the replacement', async t => {
  const { repository, secure, root } = await fixture(t); await repository.saveConnection(draft(), 0, { kind: 'replace', key: 'SYNTHETIC-OLD' }); await repository.setDefault(1, 'a', 'entry-one');
  const entered = deferred<void>(), gate = deferred<void>(); let reads = 0; const keys: string[] = [];
  const vault = new CredentialVault({ ...secure.backend, read: async (service, ref) => { if (++reads === 1) { entered.resolve(); await gate.promise; } return secure.backend.read(service, ref); } });
  const owned = await ModelRepository.open(new ModelConfigurationStore(root), vault); t.after(() => owned.close());
  const client = await owned.createClient({ fetch: async (_url, init) => { keys.push(new Headers(init?.headers).get('authorization')!); return reply(); } });
  const pending = client.complete(undefined, 'text-chat', input); await entered.promise; await owned.saveConnection(draft(), 1, { kind: 'replace', key: 'SYNTHETIC-NEW' }); gate.resolve(); await pending;
  await client.complete(undefined, 'text-chat', input); assert.deepEqual(keys, ['Bearer SYNTHETIC-OLD', 'Bearer SYNTHETIC-NEW']);
});
test('closing during credential preparation prevents publication and cleans only that new item', async t => {
  const { root, secure, store } = await fixture(t); const entered = deferred<void>(), gate = deferred<void>();
  const vault = new CredentialVault({ ...secure.backend, async create(service, ref, value) { entered.resolve(); await gate.promise; await secure.backend.create(service, ref, value); } });
  const repository = await ModelRepository.open(new ModelConfigurationStore(root), vault);
  const pending = assert.rejects(repository.saveConnection(draft(), 0, { kind: 'replace', key: 'SYNTHETIC' }), code('closed')); await entered.promise;
  const closed = repository.close(); gate.resolve(); await pending; await closed;
  assert.equal((await store.read()).revision, 0); assert.equal(secure.items.size, 0); assert.deepEqual(await readdir(root), []);
});
test('uncertain directory durability retains the published credential and reports uncertainty independently', async t => {
  const { root, store, vault, secure } = await fixture(t);
  const repository = await ModelRepository.open(new ModelConfigurationStore(root, { syncDirectory: async () => { throw Error(); } }), vault); t.after(() => repository.close());
  const result = await repository.saveConnection(draft(), 0, { kind: 'replace', key: 'SYNTHETIC' });
  assert.equal(result.durability, 'unconfirmed'); assert.equal(secure.items.size, 1); assert.deepEqual(repository.snapshot(), await store.read());
});
test('deleting and recreating an ID never makes an old connection revision valid again (ABA)', async t => {
  const { repository } = await fixture(t); await repository.saveConnection(draft(), 0); const staleRevision = repository.snapshot().connections[0]!.revision;
  await repository.removeConnection('a', staleRevision, undefined); await repository.saveConnection(draft(), 0, { kind: 'replace', key: 'SYNTHETIC-NEW-ACCOUNT' });
  await assert.rejects(repository.saveConnection({ ...draft(), displayName: 'STALE DRAFT' }, staleRevision), code('configuration_conflict'));
  assert.equal(repository.snapshot().connections[0]!.displayName, '合成连接');
});
test('publication revokes pending requests before waiting for directory sync; new requests see the published deletion', async t => {
  const { repository, root, secure } = await fixture(t); await repository.saveConnection(draft(), 0, { kind: 'replace', key: 'SYNTHETIC' }); await repository.setDefault(1, 'a', 'entry-one');
  const syncing = deferred<void>(), sync = deferred<void>(), reading = deferred<void>(), key = deferred<string | undefined>();
  const owned = await ModelRepository.open(new ModelConfigurationStore(root, { syncDirectory: async () => { syncing.resolve(); await sync.promise; } }), new CredentialVault({ ...secure.backend, read: async () => { reading.resolve(); return key.promise; } })); t.after(() => owned.close());
  let calls = 0; const client = await owned.createClient({ fetch: async () => { calls++; return reply(); } });
  const request = client.complete(undefined, 'text-chat', input); const rejected = assert.rejects(request, code('route_changed')); await reading.promise;
  const deletion = owned.removeConnection('a', 1, null); await syncing.promise;
  const published = owned.snapshot(); key.resolve(secure.items.values().next().value);
  sync.resolve(); await deletion; await rejected;
  assert.equal(published.connections.length, 0); assert.equal(calls, 0);
});
test('clearing the global default is explicit and leaves both connection-local defaults intact', async t => {
  const { repository } = await fixture(t); await repository.saveConnection(draft(), 0); await repository.setDefault(1, 'a', 'entry-one');
  await repository.setDefault(2, null); const state = repository.snapshot(); assert.equal(state.defaultConnectionID, null); assert.equal(state.connections[0]!.defaultModelEntryID, 'entry-one');
  assert.throws(() => resolveRoute(state, undefined, 'text-chat'), code('not_configured'));
});
test('swapped persisted credential references cannot send another connection key', async t => {
  const { repository, root, secure } = await fixture(t); await repository.saveConnection(draft('a'), 0, { kind: 'replace', key: 'SYNTHETIC-A' }); await repository.saveConnection(draft('b'), 0, { kind: 'replace', key: 'SYNTHETIC-B' }); await repository.setDefault(2, 'a', 'entry-one');
  const state = repository.snapshot(); [state.connections[0]!.credentialRef, state.connections[1]!.credentialRef] = [state.connections[1]!.credentialRef, state.connections[0]!.credentialRef];
  await writeFile(join(root, 'model-providers.json'), JSON.stringify(state), { mode: 0o600 });
  const reopened = await ModelRepository.open(new ModelConfigurationStore(root), new CredentialVault(secure.backend)); t.after(() => reopened.close());
  let calls = 0; const client = await reopened.createClient({ fetch: async () => { calls++; return reply(); } });
  await assert.rejects(client.complete(undefined, 'text-chat', input), code('credentials_unavailable')); assert.equal(calls, 0);
});
test('a publication adapter that renames and then rejects cannot cause deletion of a published credential', async t => {
  const { root, secure, vault, store } = await fixture(t);
  const { rename } = await import('node:fs/promises');
  const repository = await ModelRepository.open(new ModelConfigurationStore(root, { rename: async (source, target) => { await rename(source, target); throw Error('SECRET'); } }), vault); t.after(() => repository.close());
  await repository.saveConnection(draft(), 0, { kind: 'replace', key: 'SYNTHETIC' }).catch(() => {});
  const saved = await store.read(); assert.equal(saved.revision, 1); assert.ok(secure.items.has(saved.connections[0]!.credentialRef!));
});
test('a second repository cannot publish deletion while another repository owns the only online client', async t => {
  const { repository, root, vault } = await fixture(t); await repository.saveConnection(draft(), 0, { kind: 'replace', key: 'SYNTHETIC' }); await repository.setDefault(1, 'a', 'entry-one');
  const gate = deferred<Response>(), entered = deferred<void>();
  const client = await repository.createClient({ fetch: async () => { entered.resolve(); return gate.promise; } });
  const request = client.complete(undefined, 'text-chat', input); await entered.promise;
  const other = await ModelRepository.open(new ModelConfigurationStore(root), vault); t.after(() => other.close());
  const failed = await other.removeConnection('a', 1, null).then(() => false, e => code('busy')(e));
  gate.resolve(reply()); await request; assert.equal(failed, true);
  await repository.close(); await other.removeConnection('a', 1, null); assert.equal(other.snapshot().connections.length, 0);
});
test('an indeterminate publication retains the new item and closes the stale online authority', async t => {
  const { root, secure, vault } = await fixture(t); const { rename, chmod } = await import('node:fs/promises');
  const repository = await ModelRepository.open(new ModelConfigurationStore(root, { rename: async (source, target) => { await rename(source, target); await chmod(target, 0o644); throw Error('SECRET'); } }), vault); t.after(() => repository.close());
  await assert.rejects(repository.saveConnection(draft(), 0, { kind: 'replace', key: 'SYNTHETIC' }), e => code('publication_uncertain')(e) && (e as { credentialCleanup?: string }).credentialCleanup === 'retained_uncertain');
  assert.equal(secure.items.size, 1); assert.throws(() => repository.snapshot(), code('closed'));
  await assert.rejects(repository.saveConnection(draft(), 0), code('closed'));
});

test('client creation accepts transport injection without permitting a credential reader override', async t => {
  const { repository } = await fixture(t); await repository.saveConnection(draft(), 0, { kind: 'replace', key: 'SYNTHETIC-BOUND' }); await repository.setDefault(1, 'a', 'entry-one');
  let authorization: string | null = null;
  const options = {
    fetch: async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => { authorization = new Headers(init?.headers).get('authorization'); return reply(); },
    readCredential: async () => 'SYNTHETIC-OVERRIDE',
  };
  const client = await repository.createClient(options); await client.complete(undefined, 'text-chat', input);
  assert.equal(authorization, 'Bearer SYNTHETIC-BOUND');
});
test('a second repository sharing the same store cannot borrow the online owner identity', async t => {
  const { repository, store, vault } = await fixture(t); await repository.saveConnection(draft(), 0); const client = await repository.createClient();
  const other = await ModelRepository.open(store, vault); t.after(() => other.close());
  await assert.rejects(other.removeConnection('a', 1, undefined), code('busy'));
  client.close(); await repository.close(); await other.removeConnection('a', 1, undefined);
});
test('indeterminate publication closes the client before asynchronous writer-lock cleanup', async t => {
  const { repository, root, vault } = await fixture(t); await repository.saveConnection(draft(), 0, { kind: 'replace', key: 'SYNTHETIC' }); await repository.setDefault(1, 'a', 'entry-one');
  const { rename, chmod } = await import('node:fs/promises'), { PrivateDirectory } = await import('../src/models/private-directory.ts');
  let failing = false; const cleanup = deferred<void>(), gate = deferred<void>(), entered = deferred<void>(), response = deferred<Response>();
  const owned = await ModelRepository.open(new ModelConfigurationStore(root, { rename: async (source, target) => { await rename(source, target); if (failing) { await chmod(target, 0o644); throw Error(); } } }), vault); t.after(() => owned.close());
  const client = await owned.createClient({ fetch: async () => { entered.resolve(); return response.promise; } });
  const original = PrivateDirectory.prototype.removeOwned;
  t.mock.method(PrivateDirectory.prototype, 'removeOwned', async function(this: InstanceType<typeof PrivateDirectory>, name: string, identity: Parameters<typeof original>[1]) {
    if (failing && name === '.models-writer.lock') { cleanup.resolve(); await gate.promise; }
    return original.call(this, name, identity);
  });
  const outcome = client.complete(undefined, 'text-chat', input).then(() => 'reply', e => e.code); await entered.promise; failing = true;
  const deletion = assert.rejects(owned.removeConnection('a', 1, null), code('publication_uncertain')); await cleanup.promise;
  response.resolve(reply()); const result = await outcome; gate.resolve(); await deletion; assert.equal(result, 'closed');
});
test('concurrent close calls wait for one shared authority release', async t => {
  const { repository, root, vault } = await fixture(t); await repository.createClient();
  const { PrivateDirectory } = await import('../src/models/private-directory.ts'); const original = PrivateDirectory.prototype.removeOwned;
  const entered = deferred<void>(), gate = deferred<void>();
  t.mock.method(PrivateDirectory.prototype, 'removeOwned', async function(this: InstanceType<typeof PrivateDirectory>, name: string, identity: Parameters<typeof original>[1]) {
    if (name === '.models-online-owner.lock') { entered.resolve(); await gate.promise; }
    return original.call(this, name, identity);
  });
  const closing = repository.close(); await entered.promise; let settled = false; const second = repository.close().then(() => { settled = true; });
  await new Promise(r => setImmediate(r)); const early = settled; gate.resolve(); await Promise.all([closing, second]); assert.equal(early, false);
  const reopened = await ModelRepository.open(new ModelConfigurationStore(root), vault); t.after(() => reopened.close()); await reopened.createClient();
});
test('a failed owner-marker removal remains retryable and never releases another repository marker', async t => {
  const { repository, root, vault } = await fixture(t); await repository.createClient();
  const { PrivateDirectory } = await import('../src/models/private-directory.ts'); const original = PrivateDirectory.prototype.removeOwned; let once = true;
  t.mock.method(PrivateDirectory.prototype, 'removeOwned', async function(this: InstanceType<typeof PrivateDirectory>, name: string, identity: Parameters<typeof original>[1]) {
    if (once && name === '.models-online-owner.lock') { once = false; throw new ModelError('storage_unavailable'); }
    return original.call(this, name, identity);
  });
  await assert.rejects(repository.close(), code('storage_unavailable')); await repository.close();
  const reopened = await ModelRepository.open(new ModelConfigurationStore(root), vault); t.after(() => reopened.close()); await reopened.createClient();
});

});

test('a saved credential never follows an edited protocol or endpoint without explicit replacement or detach', { skip: process.platform === 'win32' }, async t => {
  const { repository, secure } = await fixture(t);
  await repository.saveConnection(draft(), 0, { kind: 'replace', key: 'SYNTHETIC-PINNED' });
  const before = repository.snapshot();
  const edited = { ...draft(), baseURL: 'https://other.invalid/v1' };
  await assert.rejects(repository.saveConnection(edited, 1), code('invalid_configuration'));
  await assert.rejects(repository.saveConnection({ ...draft(), apiProtocol: 'responses' }, 1), code('invalid_configuration'));
  assert.deepEqual(repository.snapshot(), before); assert.equal(secure.items.size, 1);
  const detached = await repository.saveConnection(edited, 1, { kind: 'remove' });
  assert.equal(detached.configuration.connections[0]!.credentialRef, undefined);
  assert.equal(secure.items.size, 1);
});
