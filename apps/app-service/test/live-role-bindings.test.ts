import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile, rename, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveRoleBindingStore } from '../src/live/role-bindings.ts';

const empty = {longmei:null,dafeiyu:null} as const;
test('live role bindings are private, strict, revisioned, and compare-and-swap', {skip:process.platform==='win32'}, async t => {
  const root=await mkdtemp(join(await realpath(tmpdir()),'live-role-bindings-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new LiveRoleBindingStore(root);
  assert.deepEqual(await store.read(),{revision:0,bindings:empty});
  const first={longmei:'pet-aaaaaaaaaaaaaaaaaaaa',dafeiyu:'pet-bbbbbbbbbbbbbbbbbbbb'};
  assert.deepEqual(await store.write(0,first),{revision:1,bindings:first});
  const reopened=new LiveRoleBindingStore(root); assert.deepEqual(await reopened.read(),{revision:1,bindings:first});
  await assert.rejects(store.write(0,empty),/conflict/);
  await assert.rejects(store.write(1,{longmei:first.longmei,dafeiyu:first.longmei}),/invalid/);
  await assert.rejects(store.write(1,{longmei:'../../secret',dafeiyu:null}),/invalid/);
  await assert.rejects(store.write(1,{longmei:first.longmei,dafeiyu:null,extra:'x'} as never),/invalid/);
  assert.deepEqual(await reopened.read(),{revision:1,bindings:first});
  const file=join(root,'role-bindings.json');
  assert.equal(JSON.parse(await readFile(file,'utf8')).schemaVersion,1);
  await rm(file); await symlink(join(root,'missing'),file);
  await assert.rejects(reopened.read()); await assert.rejects(reopened.write(1,empty));
});

test('concurrent binding updates cannot overwrite a committed revision', {skip:process.platform==='win32'}, async t => {
  const root=await mkdtemp(join(await realpath(tmpdir()),'live-role-race-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const a=new LiveRoleBindingStore(root), b=new LiveRoleBindingStore(root);
  const results=await Promise.allSettled([a.write(0,{longmei:'pet-aaaaaaaaaaaaaaaaaaaa',dafeiyu:null}),b.write(0,{longmei:null,dafeiyu:'pet-bbbbbbbbbbbbbbbbbbbb'})]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal((await a.read()).revision,1);
});

test('uncertain binding publication is surfaced and callers must reread instead of assuming rollback', {skip:process.platform==='win32'}, async t => {
  let failure: 'rename-before' | 'rename-after' | 'directory-sync' | undefined;
  const root=await mkdtemp(join(await realpath(tmpdir()),'live-role-durability-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new LiveRoleBindingStore(root,{io:{
    rename:async(from,to)=>{
      if(failure==='rename-before')throw new Error('synthetic rename failure');
      await rename(from,to);
      if(failure==='rename-after')throw new Error('synthetic post-publication failure');
    },
    syncDirectory:async()=>{if(failure==='directory-sync')throw new Error('synthetic sync failure');},
  }});
  const first={longmei:'pet-aaaaaaaaaaaaaaaaaaaa',dafeiyu:null};
  const second={longmei:null,dafeiyu:'pet-bbbbbbbbbbbbbbbbbbbb'};
  await store.write(0,first);
  const file=join(root,'role-bindings.json');
  const original=await readFile(file);

  failure='rename-before';
  await assert.rejects(store.write(1,second),/rename failure/);
  assert.deepEqual(await readFile(file),original);
  assert.deepEqual(await store.read(),{revision:1,bindings:first});

  failure='rename-after';
  await assert.rejects(store.write(1,second),/post-publication failure/);
  assert.deepEqual(await store.read(),{revision:2,bindings:second});
  await assert.rejects(store.write(1,first),/conflict/);

  failure='directory-sync';
  await assert.rejects(store.write(2,first),/sync failure/);
  assert.deepEqual(await store.read(),{revision:3,bindings:first});
});

test('binding route accepts only registered instances of the matching built-in package', {skip:process.platform==='win32'}, async t=>{
  const {createService}=await import('../src/server.ts');
  const {PetWorkspace}=await import('../src/pet-workspace.ts');
  const {longmei,dafeiyu}=await import('../../../packages/contracts/src/built-in-pets.ts');
  const root=await mkdtemp(join(await realpath(tmpdir()),'live-binding-route-'));
  const workspace=new PetWorkspace({root:join(root,'workspace'),catalog:[{...longmei,name:'龙妹'},{...dafeiyu,name:'鲸鱼妹'}]});
  const created=await workspace.mutate('add',{expectedRevision:0,package:longmei});assert.ok(created.ok);const id=created.workspace.instances[0]!.id;
  const token='7'.repeat(64);const app=createService({token,workspace,liveRoleBindings:new LiveRoleBindingStore(join(root,'live')),runtime:{snapshot:()=>({kind:'diagnostic',status:'idle',detail:''}),probe:async()=>({kind:'diagnostic',status:'ready',detail:''}),close:async()=>{}}});
  t.after(async()=>{try{await app.close();}finally{await rm(root,{recursive:true,force:true});}});const headers={host:'127.0.0.1',authorization:`Bearer ${token}`};const url='/v1/live/role-bindings';
  assert.equal((await app.inject({url,headers:{host:'127.0.0.1'}})).statusCode,401);
  assert.deepEqual((await app.inject({url,headers})).json(),{ok:true,revision:0,bindings:empty});
  const post=(payload:Record<string,unknown>)=>app.inject({method:'POST',url,headers,payload});
  assert.equal((await post({expectedRevision:0,role:'dafeiyu',petID:id})).statusCode,422);
  assert.equal((await post({expectedRevision:0,role:'longmei',petID:'pet-not-registered'})).statusCode,422);
  assert.equal((await post({expectedRevision:0,role:'longmei',petID:id,path:'/tmp'})).statusCode,400);
  const saved=await post({expectedRevision:0,role:'longmei',petID:id});assert.equal(saved.statusCode,200);assert.equal(saved.json().bindings.longmei,id);
  assert.equal((await post({expectedRevision:0,role:'longmei',petID:null})).statusCode,409);
});
