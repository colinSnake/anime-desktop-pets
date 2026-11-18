import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/server.ts';
import { PetWorkspace } from '../src/pet-workspace.ts';
const pkg = { id: 'local.pet', version: '1.0.0' };
test('pet routes preserve auth/source boundaries and perform real revisioned mutations', async t => {
 const root = await mkdtemp(join(await realpath(tmpdir()), 'pet-routes-'));
 const token = '1'.repeat(64);
 const app = createService({ token, runtime: { snapshot: () => ({kind:'diagnostic',status:'idle',detail:''}), probe: async () => ({kind:'diagnostic',status:'ready',detail:''}), close: async () => {} }, workspace: new PetWorkspace({ root, catalog: [{ ...pkg, name: '合成桌宠' }] }) });
 t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
 const headers = { host: '127.0.0.1', authorization: `Bearer ${token}` };
 assert.equal((await app.inject({ url: '/v1/pets', headers: { host: '127.0.0.1' } })).statusCode, 401);
 assert.equal((await app.inject({ url: '/v1/pets', headers: { ...headers, origin: 'https://attacker.test' } })).statusCode, 403);
 assert.equal((await app.inject({ url: '/v1/pets?path=secret', headers })).statusCode, 400);
 const read = await app.inject({ url:'/v1/pets', headers }); assert.equal(read.statusCode, 200); assert.equal(read.json().workspace.revision, 0);
 const bad = await app.inject({ method:'POST', url:'/v1/pets/add', headers, payload:{expectedRevision:0, package:pkg, path:'/private'} }); assert.equal(bad.statusCode, 400);
 const added = await app.inject({ method:'POST', url:'/v1/pets/add', headers, payload:{expectedRevision:0, package:pkg} }); assert.equal(added.statusCode,200);
 assert.equal(added.json().workspace.instances[0].phase, 'not-connected');
 const conflict = await app.inject({ method:'POST', url:'/v1/pets/theme', headers, payload:{expectedRevision:0, theme:'dark'} }); assert.equal(conflict.statusCode,409); assert.deepEqual(conflict.json(),{ok:false,error:'conflict'});
 const unknown = await app.inject({ method:'POST', url:'/v1/pets/exec', headers, payload:{} }); assert.equal(unknown.statusCode,404);
 assert.doesNotMatch(added.body, /pet-routes-|workspace-state/);
});

test('shutdown waits for every cleanup even if a runtime close throws synchronously', async t => {
 const { access } = await import('node:fs/promises');
 const root=await mkdtemp(join(await realpath(tmpdir()),'pet-close-workspace-'));
 const workspace=new PetWorkspace({root,catalog:[]});
 t.after(async()=>{await workspace.close();await rm(root,{recursive:true,force:true});});
 assert.ok((await workspace.list()).ok);
 const app=createService({token:'2'.repeat(64),workspace,runtime:{snapshot:()=>({kind:'diagnostic',status:'idle',detail:''}),probe:async()=>({kind:'diagnostic',status:'ready',detail:''}),close:()=>{throw new Error('cleanup_failure');}}});
 await assert.rejects(app.close());
 await assert.rejects(access(join(root,'.workspace-writer.lock')),{code:'ENOENT'});
});

test('behavior route keeps auth and strict ID-only input, reporting missing runtime as unavailable', async t => {
 const root=await mkdtemp(join(await realpath(tmpdir()),'pet-behavior-routes-'));
 const token='3'.repeat(64);const workspace=new PetWorkspace({root,catalog:[{...pkg,name:'合成桌宠'}]});
 const app=createService({token,workspace,runtime:{snapshot:()=>({kind:'diagnostic',status:'idle',detail:''}),probe:async()=>({kind:'diagnostic',status:'ready',detail:''}),close:async()=>{}}});
 t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 const added=await workspace.mutate('add',{expectedRevision:0,package:pkg});assert.ok(added.ok);const id=added.workspace.instances[0]!.id;
 const headers={host:'127.0.0.1',authorization:`Bearer ${token}`};const request={method:'POST' as const,url:'/v1/pets/apply-behavior',headers,payload:{expectedRevision:1,id}};
 assert.equal((await app.inject({...request,headers:{host:'127.0.0.1'}})).statusCode,401);
 assert.equal((await app.inject({...request,headers:{...headers,origin:'https://attacker.test'}})).statusCode,403);
 assert.equal((await app.inject({...request,payload:{...request.payload,taskActive:false}})).statusCode,400);
 assert.equal((await app.inject({...request,payload:{...request.payload,movement:true}})).statusCode,400);
 assert.equal((await app.inject(request)).statusCode,503);
});

test('package import route is authenticated, bounded, and returns only validated metadata', async t => {
 const root = await mkdtemp(join(await realpath(tmpdir()), 'pet-import-route-'));
 const token = '5'.repeat(64); const selected: string[] = [];
 const workspace = new PetWorkspace({ root, catalog: [], importOne: async path => {
  selected.push(path);
  if (path.endsWith('bad.petpack')) throw new Error(path);
  return { name: 'good.petpack', package: { id: 'vendor.pet', version: '1.0.0', name: '安全角色', launchable: false } };
 } });
 const app = createService({ token, workspace, runtime: { snapshot: () => ({ kind: 'diagnostic', status: 'idle', detail: '' }), probe: async () => ({ kind: 'diagnostic', status: 'ready', detail: '' }), close: async () => {} } });
 t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
 const headers = { host: '127.0.0.1', authorization: `Bearer ${token}` };
 assert.equal((await app.inject({ method: 'POST', url: '/v1/pets/import', headers: { host: '127.0.0.1' }, payload: { paths: ['/selected/good.petpack'] } })).statusCode, 401);
 assert.equal((await app.inject({ method: 'POST', url: '/v1/pets/import', headers, payload: { paths: ['/selected/good.petpack'], command: 'rm' } })).statusCode, 400);
 assert.equal((await app.inject({ method: 'POST', url: '/v1/pets/import', headers, payload: { paths: Array.from({ length: 17 }, (_, i) => `/p/${i}`) } })).statusCode, 400);
 const response = await app.inject({ method: 'POST', url: '/v1/pets/import', headers, payload: { paths: ['/selected/good.petpack', '/private/bad.petpack'] } });
 assert.equal(response.statusCode, 200);
 assert.deepEqual(response.json(), { ok: true, items: [
  { name: 'good.petpack', status: 'added', package: { id: 'vendor.pet', version: '1.0.0' } },
  { name: 'bad.petpack', status: 'failed' },
 ] });
 assert.deepEqual(selected, ['/selected/good.petpack', '/private/bad.petpack']);
 assert.doesNotMatch(response.body, /selected|private|command/);
});

test('session pause stops the service-owned diagnostic player and its start route remains gated', async t => {
 const root=await mkdtemp(join(await realpath(tmpdir()),'pet-pause-route-'));
 const token='4'.repeat(64);let status:'stopped'|'running'|'stopping'='stopped';const isStopping=()=>status==='stopping';let starts=0,stops=0;let finishStop!:()=>void;
 const player={snapshot:()=>({kind:'qt-player' as const,status,detail:''}),start:async()=>{starts++;status='running';return {kind:'qt-player' as const,status,detail:''};},stop:()=>{stops++;status='stopping';return new Promise<{kind:'qt-player';status:'stopped';detail:string}>(resolve=>{finishStop=()=>{status='stopped';resolve({kind:'qt-player',status,detail:''});};});},applyDisplayPreferences:async()=>false,applyBehaviorPreferences:async()=>false,setVisible:async()=>false,close:async()=>{status='stopped';}};
 const workspace=new PetWorkspace({root,catalog:[],stopAdditional:async()=>{const result=await player.stop();return result.status==='stopped';}});
 const app=createService({token,workspace,player,runtime:{snapshot:()=>({kind:'diagnostic',status:'idle',detail:''}),probe:async()=>({kind:'diagnostic',status:'ready',detail:''}),close:async()=>{}}});
 t.after(async()=>{finishStop?.();await app.close();await rm(root,{recursive:true,force:true});});
 const headers={host:'127.0.0.1',authorization:`Bearer ${token}`};
 assert.equal((await app.inject({method:'POST',url:'/v1/player/start',headers,payload:{}})).statusCode,200);
 const pausedPromise=app.inject({method:'POST',url:'/v1/pets/pause',headers,payload:{expectedRevision:0}});
 for(let turn=0;turn<100&&(workspace.canStartOwnedPlayer()||!isStopping());turn++) await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(workspace.canStartOwnedPlayer(),false);
 assert.equal(isStopping(),true);
 const duringPause=await app.inject({method:'POST',url:'/v1/player/start',headers,payload:{}});
 assert.equal(duringPause.statusCode,409);assert.equal(starts,1);
 const resumeDuringPause=app.inject({method:'POST',url:'/v1/pets/resume',headers,payload:{expectedRevision:0}});
 const resumeStatus=await Promise.race([resumeDuringPause.then(response=>response.statusCode),new Promise<number>(resolve=>setTimeout(()=>resolve(0),25))]);
 assert.equal(resumeStatus,409);
 finishStop();
 const paused=await pausedPromise;
 assert.equal(paused.statusCode,200);assert.equal(paused.json().workspace.linkage,'paused');assert.equal(paused.json().workspace.revision,0);
 const rejected=await app.inject({method:'POST',url:'/v1/player/start',headers,payload:{}});
 assert.equal(rejected.statusCode,409);assert.deepEqual(rejected.json(),{error:'linkage_paused'});
 assert.equal(starts,1);assert.equal(stops,1);
});
