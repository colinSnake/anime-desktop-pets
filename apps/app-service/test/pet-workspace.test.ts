import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, symlink, rm, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PetLifecycle } from '../src/pet-lifecycle.ts';
import { PetWorkspace } from '../src/pet-workspace.ts';
import { defaultPreferences } from '../src/pet-registry.ts';
const catalog = [{ id: 'local.pet', version: '1.0.0', name: '合成桌宠' }];
const pkg = { id: 'local.pet', version: '1.0.0' };
async function setup(t: any, options: Record<string, unknown> = {}) {
 const root = await mkdtemp(join(await realpath(tmpdir()), 'pet-workspace-'));
 const workspace = new PetWorkspace({ root, catalog, ...options });
 t.after(async () => { await workspace.close(); await rm(root, { recursive: true, force: true }); });
 return { root, workspace };
}
async function data(w: PetWorkspace) { const r = await w.list(); assert.ok(r.ok); return r.workspace; }
test('isolated workspace starts empty, persists definitions/theme and reopens without running pets', async t => {
 const { workspace: w, root } = await setup(t);
 assert.equal((await data(w)).instances.length, 0);
 const added = await w.mutate('add', { expectedRevision: 0, package: pkg }); assert.ok(added.ok);
 const id = added.workspace.instances[0]!.id;
 assert.equal(added.workspace.instances[0]!.phase, 'not-connected');
 const saved = await w.mutate('save', { expectedRevision: 1, id, displayName: '新名字', enabled: true, autoStartOnLaunch: false, preferences: { ...defaultPreferences(), size: 320 } }); assert.ok(saved.ok);
 assert.ok((await w.mutate('theme', { expectedRevision: 2, theme: 'dark' })).ok);
 await w.close();
 const second = new PetWorkspace({ root, catalog }); t.after(() => second.close());
 assert.equal((await data(second)).theme, 'dark');
 assert.equal((await data(second)).instances[0]!.preferences.size, 320);
 assert.doesNotMatch(JSON.stringify(await data(second)), /workspace-state|\/tmp|lease/);
 await second.close();
});
test('optimistic revisions reject stale concurrent writes rather than overwriting', async t => {
 const { workspace: w } = await setup(t);
 const results = await Promise.all(['light', 'dark'].map(theme => w.mutate('theme', { expectedRevision: 0, theme })));
 assert.equal(results.filter(r => r.ok).length, 1);
 assert.deepEqual(results.find(r => !r.ok), { ok: false, error: 'conflict' });
 assert.equal((await data(w)).revision, 1);
});

test('selected packages are bounded, imported one by one, and added to the exact-reference catalog without revision writes', async t => {
 const imported = { id: 'vendor.pet', version: '1.2.0', name: '导入角色', launchable: false };
 const calls: string[] = [];
 const { workspace: w } = await setup(t, { catalog: [], importOne: async (path: string) => {
  calls.push(path);
  if (path.endsWith('bad.petpack')) throw new Error('/private/path must not escape');
  return { name: path.split('/').pop()!, package: imported };
 } });
 const result = await w.importPackages(['/selected/good.petpack', '/selected/bad.petpack']);
 assert.deepEqual(result, { ok: true, items: [
  { name: 'good.petpack', status: 'added', package: { id: 'vendor.pet', version: '1.2.0' } },
  { name: 'bad.petpack', status: 'failed' },
 ] });
 assert.deepEqual(calls, ['/selected/good.petpack', '/selected/bad.petpack']);
 const listed = await data(w);
 assert.equal(listed.revision, 0);
 assert.deepEqual(listed.catalog, [imported]);
 const added = await w.mutate('add', { expectedRevision: 0, package: { id: imported.id, version: imported.version } });
 assert.ok(added.ok);
 assert.equal(added.workspace.instances[0]!.phase, 'not-connected');
 assert.equal((await w.importPackages(['/a', '/a'])).ok, false);
 assert.equal((await w.importPackages(Array.from({ length: 17 }, (_, i) => `/p/${i}`))).ok, false);
});

test('package catalog refuses conflicting identity metadata and never overwrites an existing version', async t => {
 const { workspace: w } = await setup(t, { importOne: async () => ({ name: 'x.petpack', package: { id: 'local.pet', version: '1.0.0', name: '替代身份', launchable: false } }) });
 assert.deepEqual(await w.importPackages(['/selected/x.petpack']), { ok: true, items: [{ name: 'x.petpack', status: 'failed' }] });
 assert.deepEqual((await data(w)).catalog, catalog);
});
test('runtime drag position is persisted by the workspace writer and failed commits leave saved coordinates unchanged', async t => {
 let failCommit = false;
 const { workspace: w, root } = await setup(t, { beforeCommit: async () => { if (failCommit) throw new Error('private'); } });
 const added = await w.mutate('add', { expectedRevision: 0, package: pkg }); assert.ok(added.ok);
 const id = added.workspace.instances[0]!.id;
 const moved = await w.recordRuntimePosition(id, { x: 140, y: 260 }); assert.ok(moved.ok);
 assert.equal(moved.workspace.revision, 2);
 assert.deepEqual(moved.workspace.instances[0]!.preferences && { x: moved.workspace.instances[0]!.preferences.x, y: moved.workspace.instances[0]!.preferences.y }, { x: 140, y: 260 });
 const unchanged = await w.recordRuntimePosition(id, { x: 140, y: 260 }); assert.ok(unchanged.ok);
 assert.equal(unchanged.workspace.revision, 2);
 failCommit = true;
 assert.deepEqual(await w.recordRuntimePosition(id, { x: 300, y: 400 }), { ok: false, error: 'storage' });
 failCommit = false;
 const saved = await w.list(); assert.ok(saved.ok);
 assert.equal(saved.workspace.revision, 2);
 assert.equal(saved.workspace.instances[0]!.preferences.x, 140);
 assert.equal(saved.workspace.instances[0]!.preferences.y, 260);
 assert.equal(JSON.parse(await readFile(join(root, 'workspace-state.json'), 'utf8')).revision, 2);
});
test('owned runtime position events update saved config and report persistence outcome separately', async t => {
 const { PetLifecycle } = await import('../src/pet-lifecycle.ts');
 let status: import('../src/pet-lifecycle.ts').OwnedSnapshot['status'] = 'stopped';
 let reportPosition: ((position: { x: number; y: number }) => void) | undefined;
 let failCommit = false;
 const lifecycle = new PetLifecycle({ supports: () => true, create: () => ({
  snapshot: () => ({ status }),
  start: async () => { status = 'running'; return { status }; },
  stop: async () => { status = 'stopped'; return { status }; },
  applyDisplayPreferences: async () => true, applyBehaviorPreferences: async () => true, setVisible: async () => true,
  setPositionListener: listener => { reportPosition = listener; }, close: async () => { status = 'stopped'; },
 }) });
 const { workspace: w } = await setup(t, { lifecycle, beforeCommit: async () => { if (failCommit) throw new Error('private'); } });
 const added = await w.mutate('add', { expectedRevision: 0, package: pkg }); assert.ok(added.ok);
 const id = added.workspace.instances[0]!.id;
 assert.ok((await w.mutate('start', { expectedRevision: 1, id })).ok);
 await new Promise(resolve => setImmediate(resolve));
 reportPosition!({ x: 55, y: 66 });
 await new Promise(resolve => setImmediate(resolve));
 const saved = await w.list(); assert.ok(saved.ok);
 assert.equal(saved.workspace.revision, 2);
 assert.deepEqual(saved.workspace.instances[0]!.positionFeedback, { x: 55, y: 66, status: 'saved' });
 failCommit = true;
 reportPosition!({ x: 75, y: 86 });
 await new Promise(resolve => setImmediate(resolve));
 const failed = await w.list(); assert.ok(failed.ok);
 assert.equal(failed.workspace.instances[0]!.preferences.x, 55);
 assert.deepEqual(failed.workspace.instances[0]!.positionFeedback, { x: 75, y: 86, status: 'failed' });
});
test('clone has stable package reference but independent position and stopped restore policy; active delete is refused', async t => {
 let phase = 'not-connected';
 const { workspace: w } = await setup(t, { phase: () => phase });
 const added = await w.mutate('add', { expectedRevision: 0, package: pkg }); assert.ok(added.ok);
 const id = added.workspace.instances[0]!.id;
 const clone = await w.mutate('clone', { expectedRevision: 1, id }); assert.ok(clone.ok);
 assert.notEqual(clone.workspace.instances[1]!.id, id);
 assert.equal(clone.workspace.instances[1]!.autoStartOnLaunch, false);
 assert.deepEqual(clone.workspace.instances[1]!.package, pkg);
 phase = 'running';
 assert.deepEqual(await w.mutate('delete', { expectedRevision: 2, id }), { ok: false, error: 'active' });
 phase = 'stopped';
 assert.ok((await w.mutate('delete', { expectedRevision: 2, id })).ok);
});
test('catalog whitelist, capacity, invalid parameters and unknown instances are enforced', async t => {
 const { workspace: w } = await setup(t);
 assert.deepEqual(await w.mutate('add', { expectedRevision: 0, package: { ...pkg, id: 'unknown' } }), { ok: false, error: 'package-unavailable' });
 assert.deepEqual(await w.mutate('clone', { expectedRevision: 0, id: 'absent' }), { ok: false, error: 'not-found' });
 assert.deepEqual(await w.mutate('theme', { expectedRevision: 0, theme: 'dark', path: '/private' }), { ok: false, error: 'invalid' });
 for (let i = 0; i < 32; i++) assert.ok((await w.mutate('add', { expectedRevision: i, package: pkg })).ok);
 assert.deepEqual(await w.mutate('add', { expectedRevision: 32, package: pkg }), { ok: false, error: 'limit' });
});
test('only one writer lease is permitted, and normal close releases only its own lease', async t => {
 const { workspace: w, root } = await setup(t); await data(w);
 const second = new PetWorkspace({ root, catalog }); t.after(() => second.close());
 assert.deepEqual(await second.list(), { ok: false, error: 'busy' });
 await w.close();
 assert.ok((await second.list()).ok);
 await second.close();
});
test('corrupt/unknown/oversized state is refused and original bytes stay intact', async t => {
 const { workspace: w, root } = await setup(t); await data(w);
 for (const bytes of ['{broken', JSON.stringify({ schemaVersion: 99 }), 'x'.repeat(128 * 1024 + 1)]) {
   await writeFile(join(root, 'workspace-state.json'), bytes);
   assert.deepEqual(await w.mutate('theme', { expectedRevision: 0, theme: 'dark' }), { ok: false, error: 'storage' });
   assert.equal(await readFile(join(root, 'workspace-state.json'), 'utf8'), bytes);
 }
});
test('linked state and linked workspace root cannot reach external files', async t => {
 const { workspace: w, root } = await setup(t); await data(w);
 const target = join(root, 'untouched'); await writeFile(target, 'private');
 await symlink(target, join(root, 'workspace-state.json'));
 assert.deepEqual(await w.list(), { ok: false, error: 'storage' });
 assert.equal(await readFile(target, 'utf8'), 'private');
 const linkedRoot = join(root, 'linked'); await symlink(root, linkedRoot, 'dir');
 const linked = new PetWorkspace({ root: linkedRoot, catalog }); t.after(() => linked.close());
 assert.deepEqual(await linked.list(), { ok: false, error: 'storage' });
});
test('directory in place of state file and failed atomic commit preserve last good bytes', async t => {
 let fail = false;
 const { workspace: w, root } = await setup(t, { beforeCommit: async () => { if (fail) throw new Error('private-path'); } });
 assert.ok((await w.mutate('theme', { expectedRevision: 0, theme: 'dark' })).ok);
 const before = await readFile(join(root, 'workspace-state.json'), 'utf8'); fail = true;
 assert.deepEqual(await w.mutate('theme', { expectedRevision: 1, theme: 'light' }), { ok: false, error: 'storage' });
 assert.equal(await readFile(join(root, 'workspace-state.json'), 'utf8'), before);
 await rm(join(root, 'workspace-state.json')); await mkdir(join(root, 'workspace-state.json'));
 assert.deepEqual(await w.list(), { ok: false, error: 'storage' });
});
test('closing drains queued changes and rejects new calls without leaking exceptions', async t => {
 const { workspace: w } = await setup(t);
 const pending = w.mutate('theme', { expectedRevision: 0, theme: 'dark' });
 const closing = w.close();
 assert.ok((await pending).ok); await closing;
 assert.deepEqual(await w.list(), { ok: false, error: 'unavailable' });
});

test('deleting and cloning again allocates a new identity rather than reusing private data', async t => {
 const { workspace: w } = await setup(t);
 const added = await w.mutate('add', { expectedRevision: 0, package: pkg }); assert.ok(added.ok);
 const original = added.workspace.instances[0]!.id;
 const clone = await w.mutate('clone', { expectedRevision: 1, id: original }); assert.ok(clone.ok);
 const removed = clone.workspace.instances[1]!.id;
 assert.ok((await w.mutate('delete', { expectedRevision: 2, id: removed })).ok);
 const fresh = await w.mutate('clone', { expectedRevision: 3, id: original }); assert.ok(fresh.ok);
 assert.notEqual(fresh.workspace.instances[1]!.id, removed);
});
test('long legacy IDs can be cloned without double-hyphen or overlong identifiers', async t => {
 const {workspace:w,root} = await setup(t); await data(w);
 const id = 'a'.repeat(53) + '-bbbbbbbbbb';
 await writeFile(join(root,'workspace-state.json'), JSON.stringify({schemaVersion:1,revision:0,theme:'system',registry:{schemaVersion:1,instances:[{id,package:pkg,displayName:'旧实例',enabled:true,autoStartOnLaunch:false,preferences:defaultPreferences()}]}}));
 const result = await w.mutate('clone',{expectedRevision:0,id}); assert.ok(result.ok);
 assert.match(result.workspace.instances[1]!.id,/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
 assert.ok(result.workspace.instances[1]!.id.length <= 64);
});

test('invalid UTF-8 is treated as corruption and cannot be rewritten by an unrelated mutation', async t => {
 const {workspace:w,root} = await setup(t); await data(w);
 const bytes = Buffer.from(JSON.stringify({schemaVersion:1,revision:0,theme:'system',registry:{schemaVersion:1,instances:[{id:'pet',package:pkg,displayName:'bad-name',enabled:true,autoStartOnLaunch:false,preferences:defaultPreferences()}]}}));
 bytes[bytes.indexOf('bad-name')] = 0xff;
 const file = join(root,'workspace-state.json'); await writeFile(file,bytes);
 assert.deepEqual(await w.list(),{ok:false,error:'storage'});
 assert.deepEqual(await w.mutate('theme',{expectedRevision:0,theme:'dark'}),{ok:false,error:'storage'});
 assert.deepEqual(await readFile(file),bytes);
});

test('instance commands preserve disk revision, stop can cancel startup, and deletion requires confirmed stop', async t => {
 const { PetLifecycle } = await import('../src/pet-lifecycle.ts');
 let status: import('../src/pet-lifecycle.ts').OwnedSnapshot['status']='stopped';
 let finish!:()=>void;
 const snapshot=()=>({status});
 const lifecycle=new PetLifecycle({supports:()=>true,create:()=>({snapshot,start:()=>{status='starting';return new Promise(()=>{});},stop:()=>{status='stopping';return new Promise(resolve=>{finish=()=>{status='stopped';resolve(snapshot());};});},applyDisplayPreferences:async()=>true,applyBehaviorPreferences:async()=>true,setVisible:async()=>true,close:async()=>{status='stopped';}})});
 const {workspace:w,root}=await setup(t,{lifecycle});
 const added=await w.mutate('add',{expectedRevision:0,package:pkg});assert.ok(added.ok);
 const id=added.workspace.instances[0]!.id;
 assert.equal(added.workspace.instances[0]!.phase,'stopped');
 const bytes=await readFile(join(root,'workspace-state.json'));
 assert.deepEqual(await w.mutate('start',{expectedRevision:0,id}),{ok:false,error:'conflict'});
 assert.deepEqual(await w.mutate('start',{expectedRevision:1,id,path:'/private'}),{ok:false,error:'invalid'});
 const started=await w.mutate('start',{expectedRevision:1,id});assert.ok(started.ok);assert.equal(started.workspace.instances[0]!.phase,'starting');
 assert.deepEqual(await w.mutate('delete',{expectedRevision:1,id}),{ok:false,error:'active'});
 const stopped=await w.mutate('stop',{expectedRevision:1,id});assert.ok(stopped.ok);assert.equal(stopped.workspace.instances[0]!.phase,'stopping');
 assert.deepEqual(await readFile(join(root,'workspace-state.json')),bytes);
 finish();await new Promise(resolve=>setImmediate(resolve));
 assert.ok((await w.mutate('delete',{expectedRevision:1,id})).ok);
});

test('display apply and visibility are per-owner runtime state and never advance the config revision', async t => {
 const { PetLifecycle } = await import('../src/pet-lifecycle.ts');
 let status: import('../src/pet-lifecycle.ts').OwnedSnapshot['status']='stopped';
 let applied={size:256,hideInFullscreen:true},visible=true;
 const snapshot=()=>({status});
 const lifecycle=new PetLifecycle({supports:()=>true,create:()=>({snapshot,start:async()=>{status='running';return snapshot();},stop:async()=>{status='stopped';return snapshot();},applyDisplayPreferences:async value=>{applied=value;return true;},applyBehaviorPreferences:async()=>true,setVisible:async value=>{visible=value;return true;},close:async()=>{status='stopped';}})});
 const {workspace:w}=await setup(t,{lifecycle});
 const added=await w.mutate('add',{expectedRevision:0,package:pkg});assert.ok(added.ok);const id=added.workspace.instances[0]!.id;
 const started=await w.mutate('start',{expectedRevision:1,id});assert.ok(started.ok);await new Promise(resolve=>setImmediate(resolve));
 assert.equal((await data(w)).revision,1);
 const saved=await w.mutate('save',{expectedRevision:1,id,displayName:'合成桌宠',enabled:true,autoStartOnLaunch:false,preferences:{...defaultPreferences(),size:320,hideInFullscreen:false}});assert.ok(saved.ok);
 assert.deepEqual(saved.workspace.instances[0]!.applied,{size:256,hideInFullscreen:true,visible:true});
 const display=await w.mutate('applyDisplay',{expectedRevision:2,id});assert.ok(display.ok);
 assert.deepEqual(applied,{size:320,hideInFullscreen:false});
 assert.equal(display.workspace.revision,2);assert.deepEqual(display.workspace.instances[0]!.applied,{size:320,hideInFullscreen:false,visible:true});
 const hidden=await w.mutate('visibility',{expectedRevision:2,id,visible:false});assert.ok(hidden.ok);
 assert.equal(hidden.workspace.revision,2);assert.equal(hidden.workspace.instances[0]!.applied?.visible,false);assert.equal(visible,false);
});
test('workspace shutdown releases writer lease even if owned runtime close fails', async t => {
 const {PetLifecycle}=await import('../src/pet-lifecycle.ts');
 const lifecycle=new PetLifecycle({supports:()=>true,create:()=>({snapshot:()=>({status:'error'}),start:async()=>({status:'error'}),stop:async()=>({status:'error'}),applyDisplayPreferences:async()=>false,applyBehaviorPreferences:async()=>false,setVisible:async()=>false,close:async()=>{throw Error('private');}})});
 const root=await mkdtemp(join(await realpath(tmpdir()),'pet-workspace-close-'));
 let second: PetWorkspace | undefined;
 t.after(async()=>{await second?.close();await rm(root,{recursive:true,force:true});});
 const w=new PetWorkspace({root,catalog,lifecycle});
 const added=await w.mutate('add',{expectedRevision:0,package:pkg});assert.ok(added.ok);
 await w.mutate('start',{expectedRevision:1,id:added.workspace.instances[0]!.id});
 await assert.rejects(w.close(),/workspace_cleanup_failed/);
 second=new PetWorkspace({root,catalog});assert.ok((await second.list()).ok);
 assert.deepEqual(await w.mutate('stop',{expectedRevision:1,id:'pet'}),{ok:false,error:'unavailable'});
});

test('behavior apply uses saved preferences, never writes revision or runtime feedback to disk', async t => {
 const {PetLifecycle}=await import('../src/pet-lifecycle.ts');
 let status:import('../src/pet-lifecycle.ts').OwnedSnapshot['status']='stopped';let fail=false;let received:unknown;
 const snapshot=()=>({status});
 const lifecycle=new PetLifecycle({supports:()=>true,create:()=>({snapshot,start:async()=>{status='running';return snapshot();},stop:async()=>{status='stopped';return snapshot();},applyDisplayPreferences:async()=>true,setVisible:async()=>true,applyBehaviorPreferences:async value=>{received=value;return !fail;},close:async()=>{status='stopped';}})});
 const {workspace:w,root}=await setup(t,{lifecycle});
 const added=await w.mutate('add',{expectedRevision:0,package:pkg});assert.ok(added.ok);const id=added.workspace.instances[0]!.id;
 await w.mutate('start',{expectedRevision:1,id});await new Promise(resolve=>setImmediate(resolve));
 const before=await readFile(join(root,'workspace-state.json'),'utf8');
 const applied=await w.mutate('applyBehavior',{expectedRevision:1,id});assert.ok(applied.ok);
 assert.deepEqual(received,{scheduledActivity:true,movement:true});assert.equal(applied.workspace.revision,1);
 assert.deepEqual(applied.workspace.instances[0]!.behavior,{status:'applied',scheduledActivity:true,movement:true});
 assert.equal(await readFile(join(root,'workspace-state.json'),'utf8'),before);
 assert.deepEqual(await w.mutate('applyBehavior',{expectedRevision:0,id}),{ok:false,error:'conflict'});
 fail=true;assert.deepEqual(await w.mutate('applyBehavior',{expectedRevision:1,id}),{ok:false,error:'apply-failed'});
 const failed=await w.list();assert.ok(failed.ok);assert.deepEqual(failed.workspace.instances[0]!.behavior,{status:'failed'});
 assert.equal(await readFile(join(root,'workspace-state.json'),'utf8'),before);
});

test('pause gates owned and additional player starts, reports unconfirmed stop, and resumes without restoring', async t => {
 const {PetLifecycle}=await import('../src/pet-lifecycle.ts');
 let status:import('../src/pet-lifecycle.ts').OwnedSnapshot['status']='stopped';
 let finishStop!:(value:import('../src/pet-lifecycle.ts').OwnedSnapshot)=>void;
 const calls:string[]=[];
 const lifecycle=new PetLifecycle({supports:()=>true,create:()=>({
  snapshot:()=>({status}),
  start:async()=>{status='running';return {status};},
  stop:()=>{calls.push('stop');status='stopping';return new Promise(resolve=>{finishStop=value=>{status=value.status;resolve(value);};});},
  applyDisplayPreferences:async()=>status==='running',applyBehaviorPreferences:async()=>status==='running',setVisible:async()=>status==='running',close:async()=>{status='stopped';},
 })});
 const additional=async()=>{calls.push('additional-stop');return false;};
 const {workspace:w,root}=await setup(t,{lifecycle,stopAdditional:additional});
 const added=await w.mutate('add',{expectedRevision:0,package:pkg});assert.ok(added.ok);const id=added.workspace.instances[0]!.id;
 assert.ok((await w.mutate('start',{expectedRevision:1,id})).ok);
 await new Promise(resolve=>setImmediate(resolve));
 const pausedPromise=w.mutate('pause',{expectedRevision:1});
 assert.equal(w.canStartOwnedPlayer(),false);
 const blockedStart=w.mutate('start',{expectedRevision:1,id});
 const stopDeadline=Date.now()+1000;
 while(!calls.includes('stop')&&Date.now()<stopDeadline) await new Promise(resolve=>setTimeout(resolve,5));
 assert.ok(calls.includes('stop'));
 finishStop({status:'stopped'});
 assert.deepEqual(await blockedStart,{ok:false,error:'busy'});
 assert.deepEqual(await pausedPromise,{ok:false,error:'apply-failed'});
 const failed=await w.list();assert.ok(failed.ok);assert.equal(failed.workspace.linkage,'stop-unconfirmed');assert.equal(w.taskLease.enable(),false);
 assert.equal(failed.workspace.revision,1);assert.equal(failed.workspace.instances[0]!.phase,'stopped');
 assert.doesNotMatch(await readFile(join(root,'workspace-state.json'),'utf8'),/linkage|paused/);
 assert.deepEqual(await w.mutate('resume',{expectedRevision:1}),{ok:false,error:'active'});
 assert.deepEqual(calls,['stop','additional-stop']);
});

test('workspace pause and close revoke task reads synchronously; resume does not reauthorize', async t => {
 const {workspace:w,root}=await setup(t);
 const seeded=await w.mutate('add',{expectedRevision:0,package:pkg});assert.ok(seeded.ok);
 const before=await readFile(join(root,'workspace-state.json'),'utf8');
 const lease=w.taskLease;
 const probe=async ()=>'running' as const;
 const read=async ()=>({state:'working',activeCount:1,startSerial:2});
 for (const expectedRevision of [0,1]) {
  assert.ok(lease.enable());assert.ok(await lease.refresh(probe));
  let deliver!: (value: Awaited<ReturnType<typeof read>>) => void;
  let permit!: AbortSignal;
  const pending=lease.sample(signal=>{permit=signal;return new Promise(resolve=>{deliver=resolve;});});
  const paused=w.mutate('pause',{expectedRevision});
  assert.equal(permit.aborted,true);
  assert.equal(lease.enable(),false);
  assert.equal(await pending,undefined);
  deliver(await read());
  const result=await paused;
  if(expectedRevision===0) assert.deepEqual(result,{ok:false,error:'conflict'});
  else {
   assert.ok(result.ok);assert.equal(result.workspace.linkage,'paused');
   assert.equal(lease.enable(),false);
   assert.ok((await w.mutate('resume',{expectedRevision:1})).ok);
  }
  assert.equal(await lease.refresh(probe),false);
  assert.equal(await lease.sample(read),undefined);
  assert.equal(await readFile(join(root,'workspace-state.json'),'utf8'),before);
  await assert.rejects(readFile(join(root,'codex-task-lease.json')),{code:'ENOENT'});
 }
 assert.ok(lease.enable());assert.ok(await lease.refresh(probe));
 let permit!:AbortSignal;
 const pending=lease.sample(signal=>{permit=signal;return new Promise(resolve=>signal.addEventListener('abort',()=>resolve(undefined),{once:true}));});
 const closed=w.close();
 assert.equal(permit.aborted,true);
 assert.equal(lease.enable(),false);
 assert.equal(await pending,undefined);
 await closed;
});

function startupLifecycle(starts: string[], supports: (pet: import('../../../packages/contracts/src/pets.ts').PetDefinition) => boolean = () => true) {
 return new PetLifecycle({ supports, create: pet => {
  let status: 'stopped' | 'running' = 'stopped';
  return {
   snapshot: () => ({ status }),
   start: async () => { starts.push(pet.id); status = 'running'; return { status }; },
   stop: async () => { status = 'stopped'; return { status }; },
   close: async () => { status = 'stopped'; },
   applyDisplayPreferences: async () => true, applyBehaviorPreferences: async () => true, setVisible: async () => true,
  };
 } });
}

test('startup registers one default pet, uses its saved launch flag, and never restarts it in the same session', async t => {
 const starts: string[] = [];
 const { workspace: w, root } = await setup(t, { lifecycle: startupLifecycle(starts) });
 const launched = await w.startOnLaunch(pkg);
 assert.ok(launched.ok);
 assert.equal(launched.workspace.revision, 1);
 assert.equal(launched.workspace.instances.length, 1);
 const pet = launched.workspace.instances[0]!;
 assert.equal(pet.displayName, '合成桌宠');
 assert.equal(pet.autoStartOnLaunch, true);
 assert.deepEqual(starts, [pet.id]);
 assert.equal((await data(w)).instances[0]!.phase, 'running');
 const stopped = await w.mutate('stop', { expectedRevision: 1, id: pet.id }); assert.ok(stopped.ok);
 await w.startOnLaunch(pkg);
 assert.deepEqual(starts, [pet.id]);
 const before = await readFile(join(root, 'workspace-state.json'));
 await w.close();
 const next = new PetWorkspace({ root, catalog, lifecycle: startupLifecycle(starts) }); t.after(() => next.close());
 const restarted = await next.startOnLaunch(pkg); assert.ok(restarted.ok);
 assert.deepEqual(starts, [pet.id, pet.id]);
 assert.deepEqual(await readFile(join(root, 'workspace-state.json')), before);
 await next.close();
});

test('startup upgrades the first enabled saved pet once and preserves opt-out, clones and deletion', async t => {
 const { workspace: old, root } = await setup(t);
 const added = await old.mutate('add', { expectedRevision: 0, package: pkg }); assert.ok(added.ok);
 const id = added.workspace.instances[0]!.id;
 const cloned = await old.mutate('clone', { expectedRevision: 1, id }); assert.ok(cloned.ok);
 const clone = cloned.workspace.instances[1]!.id;
 await old.close();
 const starts: string[] = [];
 const reopen = () => { const w = new PetWorkspace({ root, catalog, lifecycle: startupLifecycle(starts) }); t.after(() => w.close()); return w; };
 const first = reopen();
 const upgraded = await first.startOnLaunch(pkg); assert.ok(upgraded.ok);
 assert.deepEqual(starts, [id]);
 assert.deepEqual(upgraded.workspace.instances.map(pet => [pet.id, pet.autoStartOnLaunch]), [[id, true], [clone, false]]);
 const saved = await first.mutate('save', { expectedRevision: upgraded.workspace.revision, id, displayName: '已关闭自动启动', enabled: true, autoStartOnLaunch: false, preferences: defaultPreferences() }); assert.ok(saved.ok);
 await first.close();
 const second = reopen();
 const optedOut = await second.startOnLaunch(pkg); assert.ok(optedOut.ok);
 assert.deepEqual(starts, [id]);
 assert.equal(optedOut.workspace.revision, saved.workspace.revision);
 for (const [offset, target] of [id, clone].entries()) assert.ok((await second.mutate('delete', { expectedRevision: optedOut.workspace.revision + offset, id: target })).ok);
 await second.close();
 const last = reopen();
 const third = await last.startOnLaunch(pkg); assert.ok(third.ok);
 assert.deepEqual(third.workspace.instances, []);
 assert.deepEqual(starts, [id]);
 await last.close();
});

test('startup skips disabled and unavailable instances and enforces the existing three-slot cap', async t => {
 const starts: string[] = [];
 const extra = { id: 'local.unplayable', version: '1.0.0', name: '未接播放器', launchable: false };
 const { workspace: w } = await setup(t, { catalog: [extra, ...catalog], lifecycle: startupLifecycle(starts, pet => pet.package.id === pkg.id) });
 const expected: string[] = [];
 for (let n = 0; n < 6; n++) {
  const added = await w.mutate('add', { expectedRevision: n * 2, package: n === 0 ? { id: extra.id, version: extra.version } : pkg }); assert.ok(added.ok);
  const pet = added.workspace.instances[n]!;
  assert.ok((await w.mutate('save', { expectedRevision: n * 2 + 1, id: pet.id, displayName: `合成 ${n}`, autoStartOnLaunch: true, enabled: n !== 1, preferences: defaultPreferences() })).ok);
  if (n >= 2 && n < 5) expected.push(pet.id);
 }
 const loaded = await w.startOnLaunch(pkg); assert.ok(loaded.ok);
 assert.deepEqual(starts, expected);
 assert.equal(loaded.workspace.instances[0]!.phase, 'not-connected');
 assert.equal(loaded.workspace.instances[5]!.phase, 'stopped');
});

test('startup stays blocked during pause, shutdown, storage failure or when no player is available', async t => {
 const starts: string[] = [];
 const paused = (await setup(t, { lifecycle: startupLifecycle(starts) })).workspace;
 const queuedStart = paused.startOnLaunch(pkg);
 const pause = paused.mutate('pause', { expectedRevision: 0 });
 assert.deepEqual(await queuedStart, { ok: false, error: 'busy' });
 assert.ok((await pause).ok);
 const closing = (await setup(t, { lifecycle: startupLifecycle(starts) })).workspace;
 const blocked = closing.startOnLaunch(pkg);
 await closing.close();
 assert.deepEqual(await blocked, { ok: false, error: 'unavailable' });
 const disconnected = (await setup(t, { lifecycle: startupLifecycle(starts, () => false) })).workspace;
 const unloaded = await disconnected.startOnLaunch(pkg); assert.ok(unloaded.ok);
 assert.deepEqual(unloaded.workspace.instances, []);
 const { workspace: corrupt, root } = await setup(t, { lifecycle: startupLifecycle(starts) });
 const path = join(root, 'workspace-state.json');
 await writeFile(path, '{bad registry');
 assert.deepEqual(await corrupt.startOnLaunch(pkg), { ok: false, error: 'storage' });
 assert.equal(await readFile(path, 'utf8'), '{bad registry');
 assert.deepEqual(starts, []);
});
