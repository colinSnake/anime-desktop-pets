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

test('live persona context excludes candidate, expired, unshared, and other-instance memories', {skip:process.platform==='win32'}, async t=>{
 const {mkdtemp,realpath,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const {PetWorkspace}=await import('../src/pet-workspace.ts');
 const {CharacterRepository}=await import('../src/characters/repository.ts');
 const {LiveRoleBindingStore}=await import('../src/live/role-bindings.ts');
 const {buildLivePersonaContext}=await import('../src/live/persona-context.ts');
 const {longmei}=await import('../../../packages/contracts/src/built-in-pets.ts');
 const root=await mkdtemp(join(await realpath(tmpdir()),'live-context-memory-'));
 const workspace=new PetWorkspace({root:join(root,'workspace'),catalog:[{...longmei,name:'龙妹'}]});
 const characters=new CharacterRepository(join(root,'characters'),{clock:()=>new Date('2025-01-01T00:00:00.000Z')});
 const bindings=new LiveRoleBindingStore(join(root,'live'));
 const shares=new LiveShareStore(join(root,'live'));
 t.after(async()=>{await Promise.all([workspace.close(),characters.close(),bindings.close(),shares.close()]);await rm(root,{recursive:true,force:true});});
 const first=await workspace.mutate('add',{expectedRevision:0,package:longmei});assert.ok(first.ok);
 const second=await workspace.mutate('add',{expectedRevision:1,package:longmei});assert.ok(second.ok);
 const petID=first.workspace.instances[0]!.id,otherPetID=second.workspace.instances[1]!.id;
 await bindings.write(0,{longmei:petID,dafeiyu:null});
 let state=await characters.apply(petID,0,{type:'saveIdentity',value:{name:'本角色',role:'身份',background:'背景',personality:'性格',values:'价值',motivations:'动机',relationship:'关系',speakingStyle:'表达',knowledgeScope:'知识范围',boundaries:'边界'}});
 const identityRevision=state.state.identity!.revision;
 const draft=(text:string,kind:'知识'|'事实'|'偏好'='知识',expiresAt?:string)=>({kind,text,source:`本地材料 ${text}`,citation:`${text} 第一节`,version:'v1',...(expiresAt&&{expiresAt})});
 const expiredAdded=await characters.apply(petID,state.state.revision,{type:'addMemory',value:draft('已过期内容','知识','2025-02-01T00:00:00.000Z')});
 const expired=expiredAdded.state.memories[0]!.current;
 const expiredConfirmed=await characters.apply(petID,expiredAdded.state.revision,{type:'confirmMemory',id:expired.id});
 const expiredRevision=expiredConfirmed.state.memories[0]!.current.revision;
 const candidateAdded=await characters.apply(petID,expiredConfirmed.state.revision,{type:'addMemory',value:draft('待审核内容','事实')});
 const candidate=candidateAdded.state.memories[1]!.current;
 const unsharedAdded=await characters.apply(petID,candidateAdded.state.revision,{type:'addMemory',value:draft('未授权内容','偏好')});
 const unshared=unsharedAdded.state.memories[2]!.current;
 const unsharedConfirmed=await characters.apply(petID,unsharedAdded.state.revision,{type:'confirmMemory',id:unshared.id});
 assert.equal(unsharedConfirmed.state.memories[2]!.current.status,'confirmed');
 const authorizedAdded=await characters.apply(petID,unsharedConfirmed.state.revision,{type:'addMemory',value:draft('已授权知识','知识','2099-02-01T00:00:00.000Z')});
 const authorized=authorizedAdded.state.memories[3]!.current;
 const authorizedConfirmed=await characters.apply(petID,authorizedAdded.state.revision,{type:'confirmMemory',id:authorized.id});
 const authorizedRevision=authorizedConfirmed.state.memories[3]!.current.revision;
 const otherAdded=await characters.apply(otherPetID,0,{type:'addMemory',value:draft('其他实例内容')});
 const other=otherAdded.state.memories[0]!.current;
 const otherConfirmed=await characters.apply(otherPetID,otherAdded.state.revision,{type:'confirmMemory',id:other.id});
 const otherRevision=otherConfirmed.state.memories[0]!.current.revision;
 await shares.write(0,[
  {petID,recordID:'identity',recordRevision:identityRevision,kind:'identity'},
  {petID,recordID:expired.id,recordRevision:expiredRevision,kind:'memory'},
  {petID,recordID:candidate.id,recordRevision:candidate.revision,kind:'memory'},
  {petID,recordID:authorized.id,recordRevision:authorizedRevision,kind:'memory'},
  {petID:otherPetID,recordID:other.id,recordRevision:otherRevision,kind:'memory'},
 ]);
 const context=await buildLivePersonaContext({workspace,characters,bindings,shares,role:'longmei',scene:'desk-room',question:'你好'});
 assert.match(context.system,/本角色/);
 assert.match(context.system,/已授权知识/);
 for(const excluded of ['已过期内容','待审核内容','未授权内容','其他实例内容'])assert.doesNotMatch(context.system,new RegExp(excluded));
 const deleted=await workspace.mutate('delete',{expectedRevision:2,id:petID});assert.ok(deleted.ok);
 assert.equal(deleted.workspace.instances.some(instance=>instance.id===petID),false);
 await assert.rejects(buildLivePersonaContext({workspace,characters,bindings,shares,role:'longmei',scene:'desk-room',question:'你好'}),/unavailable/);
});
