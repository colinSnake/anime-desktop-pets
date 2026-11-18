import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createService } from '../src/server.ts';
import { ModelManagement } from '../src/models/management.ts';
import { configuration } from './fixtures/models.ts';
import { syntheticVault } from './fixtures/secure-models.ts';

const token = 'a'.repeat(64);
const headers = { host: '127.0.0.1', authorization: `Bearer ${token}` };
const draft = () => { const { revision: _r, credentialRef: _c, ...connection } = configuration().connections[0]!; return connection; };
const snapshot = () => ({kind:'diagnostic' as const,status:'idle' as const,detail:''});
const runtime = { snapshot, probe: async () => snapshot(), close: async () => {} };
const models = '/v1/models';
async function fixture(t: test.TestContext) {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'pet-model-management-')); t.after(() => rm(base,{recursive:true,force:true}));
  const root = join(base, 'models'), { backend, failures, items } = syntheticVault(); let reads = 0;
  const management = new ModelManagement(root, { ...backend, async read(...args) { reads++; return backend.read(...args); } });
  const app = createService({ token, runtime, models: management }); t.after(() => app.close());
  const get = () => app.inject({ method:'GET', url:models, headers });
  const post = (action: string, payload: object) => app.inject({ method:'POST', url:`${models}/${action}`, headers, payload });
  return { app, root, failures, items, get, post, reads: () => reads };
}
test('model management inherits loopback authentication and enables only fixed management routes', { skip: process.platform === 'win32' }, async t => {
  const { app, get, post } = await fixture(t);
  assert.equal((await app.inject({ url:models, headers:{host:headers.host} })).statusCode, 401);
  for (const extra of [{origin:'https://synthetic.invalid'}, {host:'evil.invalid'}]) assert.equal((await app.inject({ url:models, headers:{...headers,...extra} })).statusCode, 403);
  assert.equal((await get()).headers['cache-control'], 'no-store');
  assert.equal((await post('test',{})).statusCode, 400);
  for (const action of ['complete','unknown']) assert.equal((await post(action,{})).statusCode, 404);
  assert.equal((await app.inject({url:models+'?path=/tmp/elsewhere', headers})).statusCode, 400);
});
test('model storage is opt-in on bootstrap and does not change other service routes', async t => {
  const app = createService({token,runtime}); t.after(() => app.close());
  assert.equal((await app.inject({url:models,headers})).statusCode, 404);
  assert.equal((await app.inject({method:'POST',url:`${models}/test`,headers,payload:{}})).statusCode, 404);
  assert.equal((await app.inject({url:'/v1/snapshot',headers})).statusCode, 200);
});
test('trusted management saves missing-key drafts, replaces explicitly, preserves defaults and redacts references', { skip: process.platform === 'win32' }, async t => {
  const { root, items, failures, get, post, reads } = await fixture(t);
  assert.deepEqual((await get()).json(), {version:1,ok:true,configuration:{revision:0,defaultConnectionID:null,connections:[]}});
  const missing = await post('save',{connection:draft(), expectedRevision:0, credential:{kind:'keep'}});
  assert.equal(missing.statusCode, 200); assert.equal(missing.json().configuration.connections[0].credentialState,'missing'); assert.equal(items.size,0);
  const saved = await post('save',{connection:draft(), expectedRevision:1, credential:{kind:'replace',key:'SYNTHETIC-REPLACEMENT'}});
  assert.equal(saved.statusCode,200); assert.equal(saved.json().configuration.connections[0].credentialState,'reference-present');
  assert.doesNotMatch(saved.body, /SYNTHETIC-REPLACEMENT|credentialRef|mcred-v1/);
  const disk = await readFile(join(root,'model-providers.json'),'utf8'); assert.doesNotMatch(disk,/SYNTHETIC-REPLACEMENT/);
  const conflict = await post('save',{connection:draft(), expectedRevision:1, credential:{kind:'keep'}}); assert.equal(conflict.statusCode,409);
  failures.create = true;
  const failed = await post('save',{connection:draft(), expectedRevision:2, credential:{kind:'replace',key:'SYNTHETIC-NOT-SAVED'}});
  assert.equal(failed.statusCode,503); assert.equal(failed.json().error,'credentials_unavailable'); assert.doesNotMatch(failed.body, /SECRET|NOT-SAVED/);
  assert.equal(await readFile(join(root,'model-providers.json'),'utf8'),disk); assert.equal(items.size,1);
  const defaulted = await post('default',{expectedRevision:2,connectionID:draft().id,entryID:'entry-one'}); assert.equal(defaulted.json().configuration.defaultConnectionID,draft().id);
  const removed = await post('remove',{connectionID:draft().id,expectedRevision:2,replacementDefault:null});
  assert.equal(removed.statusCode,200); assert.equal(removed.json().retainedCredentialVersions,true); assert.equal(removed.json().configuration.defaultConnectionID,null);
  assert.equal((await get()).json().configuration.connections.length,0); assert.equal(reads(),0);
});
test('extra fields, unbounded body and extra credential actions are rejected before reaching storage', { skip: process.platform === 'win32' }, async t => {
  const { get, post, items } = await fixture(t);
  const save = {connection:draft(),expectedRevision:0,credential:{kind:'keep'}};
  for (const payload of [{...save,headers:{authorization:'SYNTHETIC'}}, {...save,connection:{...save.connection,credentialRef:'SYNTHETIC'}},{...save,credential:{kind:'keep',key:'SYNTHETIC'}},{...save,expectedRevision:'0'}]) {
    const invalid = await post('save',payload); assert.equal(invalid.statusCode,400); assert.doesNotMatch(invalid.body,/SYNTHETIC/);
  }
  assert.equal((await post('save',{...save,excess:'x'.repeat(70_000)})).statusCode,413);
  assert.equal((await get()).json().configuration.revision,0); assert.equal(items.size,0);
});

test('list observes another trusted writer and reports disk corruption instead of returning stale success', { skip: process.platform === 'win32' }, async t => {
  const { get, root } = await fixture(t);
  assert.equal((await get()).json().configuration.revision,0);
  const { ModelConfigurationStore } = await import('../src/models/configuration-store.ts');
  const { writeFile } = await import('node:fs/promises');
  await new ModelConfigurationStore(root).commit(0, state => ({ ...state, connections: [{ ...draft(), revision:1 }] }));
  assert.equal((await get()).json().configuration.revision,1);
  await writeFile(join(root,'model-providers.json'),'{corrupt');
  const result = await get(); assert.equal(result.statusCode,503);
  assert.equal(result.json().error,'storage_unavailable');
});

test('concurrent writes are not queued; close during preparation leaves old disk state and discards only that credential', { skip: process.platform === 'win32' }, async t => {
  const base = await mkdtemp(join(await realpath(tmpdir()),'pet-model-management-close-'));
  t.after(() => rm(base,{recursive:true,force:true}));
  const { backend, items } = syntheticVault();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  const management = new ModelManagement(base, { ...backend, async create(...args) { entered(); await gate; return backend.create(...args); } });
  const pending = management.run('save',{connection:draft(),expectedRevision:0,credential:{kind:'replace',key:'SYNTHETIC'}});
  await started;
  try {
    assert.deepEqual(await management.run('default',{expectedRevision:0,connectionID:null}),{version:1,ok:false,error:'busy'});
    const close = management.close();
    assert.deepEqual(await management.run('list',undefined),{version:1,ok:false,error:'unavailable'});
    release();
    assert.equal((await pending).ok,false); await close;
    assert.equal(items.size,0);
    await assert.rejects(readFile(join(base,'model-providers.json')),{code:'ENOENT'});
  } finally { release(); await pending; await management.close(); }
});

test('a prepared item with lost Keychain acknowledgement leaves the old config and reports uncertain cleanup', { skip: process.platform === 'win32' }, async t => {
  const { CredentialPreparationUncertain } = await import('../src/models/credentials.ts');
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pet-model-native-uncertain-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const { backend, items } = syntheticVault(); let removes = 0;
  const management = new ModelManagement(root, { ...backend,
    async create(...args) { await backend.create(...args); throw new CredentialPreparationUncertain(); },
    async remove(...args) { removes++; await backend.remove(...args); },
  });
  t.after(() => management.close());
  const result = await management.run('save',{connection:draft(),expectedRevision:0,credential:{kind:'replace',key:'SYNTHETIC'}});
  assert.deepEqual(result,{version:1,ok:false,error:'credentials_unavailable',credentialCleanup:'retained_uncertain'});
  assert.equal(items.size,1); assert.equal(removes,0);
  await assert.rejects(readFile(join(root,'model-providers.json')),{code:'ENOENT'});
});


test('an unconfirmed publication permits only a validated disk read and never accepts another write', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pet-model-management-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { backend, items } = syntheticVault();
  const service = new ModelManagement(root, backend, {
    rename: async (from, to) => { await rename(from, to); await chmod(to, 0o644); throw Error('synthetic publish uncertainty'); },
  });
  t.after(() => service.close());
  const edit = { connection: draft(), expectedRevision: 0, credential: { kind: 'replace', key: 'SYNTHETIC' } };
  assert.deepEqual(await service.run('save', edit), { version: 1, ok: false, error: 'publication_uncertain', credentialCleanup: 'retained_uncertain' });
  assert.equal(items.size, 1);
  assert.deepEqual(await service.run('list', undefined), { version: 1, ok: false, error: 'storage_unavailable' });
  await chmod(join(root, 'model-providers.json'), 0o600);
  const view = await service.run('list', undefined);
  assert.equal(view.ok && view.configuration.revision, 1);
  assert.equal(view.ok && view.writesBlocked, true);
  assert.doesNotMatch(JSON.stringify(view), /SYNTHETIC|mcred-v1/);
  assert.deepEqual(await service.run('default', { expectedRevision: 1, connectionID: null }), { version: 1, ok: false, error: 'publication_uncertain' });
  assert.equal(items.size, 1);
});
