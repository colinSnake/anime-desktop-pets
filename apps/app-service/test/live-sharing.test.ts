import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp,rm,readFile,realpath,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';import { join } from 'node:path';
import { LiveShareStore } from '../src/live/sharing.ts';
const one={petID:'pet-aaaaaaaaaaaaaaaaaaaa',recordID:'identity',recordRevision:1,kind:'identity'} as const;
test('live sharing grants are revision-bound, opt-in, private and CAS-protected',{skip:process.platform==='win32'},async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'live-share-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new LiveShareStore(root);
 assert.deepEqual(await store.read(),{revision:0,grants:[]});const saved=await store.write(0,[one]);assert.deepEqual(saved,{revision:1,grants:[one]});
 assert.deepEqual(await new LiveShareStore(root).read(),saved);await assert.rejects(store.write(0,[]),/conflict/);
 await assert.rejects(store.write(1,[one,one]),/invalid/);
 await assert.rejects(store.write(1,[{...one,recordRevision:0}]),/invalid/);
 await assert.rejects(store.write(1,[{...one,petID:'../x'}]),/invalid/);
 const file=join(root,'share-grants.json');assert.equal(JSON.parse(await readFile(file,'utf8')).schemaVersion,1);
 await rm(file);await symlink(join(root,'missing'),file);await assert.rejects(store.read());
});

test('live authorization is independent from chatShare and context rechecks current revisions and binding', {skip:process.platform==='win32'},async t=>{
 const {mkdtemp,realpath,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {createService}=await import('../src/server.ts');const {PetWorkspace}=await import('../src/pet-workspace.ts');const {CharacterRepository}=await import('../src/characters/repository.ts');const {LiveRoleBindingStore}=await import('../src/live/role-bindings.ts');const {buildLivePersonaContext}=await import('../src/live/persona-context.ts');const {longmei}=await import('../../../packages/contracts/src/built-in-pets.ts');
 const root=await mkdtemp(join(await realpath(tmpdir()),'live-context-'));const workspace=new PetWorkspace({root:join(root,'workspace'),catalog:[{...longmei,name:'龙妹'}]});const characters=new CharacterRepository(join(root,'characters'));const bindings=new LiveRoleBindingStore(join(root,'live'));const shares=new LiveShareStore(join(root,'live'));
 const added=await workspace.mutate('add',{expectedRevision:0,package:longmei});assert.ok(added.ok);const id=added.workspace.instances[0]!.id;await characters.apply(id,0,{type:'saveIdentity',value:{name:'龙妹',role:'合成身份',background:'背景',personality:'性格',values:'价值',motivations:'愿望',relationship:'关系',speakingStyle:'表达',knowledgeScope:'范围',boundaries:'边界'}});
 const token='8'.repeat(64);const app=createService({token,workspace,characters,liveProfile:undefined,liveRoleBindings:bindings,liveShares:shares,runtime:{snapshot:()=>({kind:'diagnostic',status:'idle',detail:''}),probe:async()=>({kind:'diagnostic',status:'ready',detail:''}),close:async()=>{}}});t.after(async()=>{try{await app.close();}finally{await rm(root,{recursive:true,force:true});}});
 const headers={host:'127.0.0.1',authorization:`Bearer ${token}`};const post=(url:string,payload:Record<string,unknown>)=>app.inject({method:'POST',url,headers,payload});
 assert.equal((await post('/v1/live/role-bindings',{expectedRevision:0,role:'longmei',petID:id})).statusCode,200);
 const hidden=await buildLivePersonaContext({workspace,characters,bindings,shares,role:'longmei',scene:'desk-room',question:'你好'});assert.doesNotMatch(hidden.system,/合成身份/);
 assert.equal((await post('/v1/live/shares',{expectedRevision:0,role:'longmei',records:[{kind:'identity',recordID:'identity',recordRevision:1}]})).statusCode,200);
 const visible=await buildLivePersonaContext({workspace,characters,bindings,shares,role:'longmei',scene:'desk-room',question:'你好'});assert.match(visible.system,/合成身份/);assert.doesNotMatch(visible.system,/密码/);
 await characters.apply(id,1,{type:'saveIdentity',value:{name:'龙妹',role:'改过的身份',background:'背景',personality:'性格',values:'价值',motivations:'愿望',relationship:'关系',speakingStyle:'表达',knowledgeScope:'范围',boundaries:'边界'}});
 const stale=await buildLivePersonaContext({workspace,characters,bindings,shares,role:'longmei',scene:'desk-room',question:'你好'});assert.doesNotMatch(stale.system,/改过的身份/);
 await assert.rejects(buildLivePersonaContext({workspace,characters,bindings,shares,role:'dafeiyu',scene:'desk-room',question:'你好'}),/unbound/);
});
