import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createService} from '../src/server.ts';
import {PetWorkspace} from '../src/pet-workspace.ts';
import {CharacterRepository} from '../src/characters/repository.ts';
import {LiveRoleBindingStore} from '../src/live/role-bindings.ts';
import {LiveShareStore} from '../src/live/sharing.ts';
import {longmei,dafeiyu} from '../../../packages/contracts/src/built-in-pets.ts';
const identity = {name:'合成龙妹',role:'合成人格',background:'',personality:'利落',values:'',motivations:'',relationship:'',speakingStyle:'简洁',knowledgeScope:'',boundaries:'不泄露资料'};
async function fixture(t:TestContext) {
 const root=await mkdtemp(join(await realpath(tmpdir()),'live-share-ui-'));
 const workspace=new PetWorkspace({root:join(root,'workspace'),catalog:[{...longmei,name:'龙妹'},{...dafeiyu,name:'鲸鱼妹'}]});
 const characters=new CharacterRepository(join(root,'characters'));
 const bindings=new LiveRoleBindingStore(join(root,'live')),shares=new LiveShareStore(join(root,'live'));
 const first=await workspace.mutate('add',{expectedRevision:0,package:longmei});assert.ok(first.ok);
 const petID=first.workspace.instances[0]!.id;
 const second=await workspace.mutate('add',{expectedRevision:1,package:longmei});assert.ok(second.ok);
 const otherID=second.workspace.instances.find(i=>i.id!==petID)!.id;
 await characters.apply(petID,0,{type:'saveIdentity',value:identity});
 await characters.apply(otherID,0,{type:'saveIdentity',value:{...identity,name:'另一只'}});
 const app=createService({token:'8'.repeat(64),workspace,characters,liveRoleBindings:bindings,liveShares:shares,runtime:{snapshot:()=>({kind:'diagnostic',status:'idle',detail:''}),probe:async()=>({kind:'diagnostic',status:'ready',detail:''}),close:async()=>{}}});
 t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 const headers={host:'127.0.0.1',authorization:`Bearer ${'8'.repeat(64)}`};
 const post=(url:string,payload:Record<string,unknown>)=>app.inject({method:'POST',url,headers,payload});
 const read=()=>app.inject({method:'GET',url:'/v1/live/shares?role=longmei',headers});
 assert.equal((await post('/v1/live/role-bindings',{expectedRevision:0,role:'longmei',petID})).statusCode,200);
 return {characters,bindings,shares,petID,otherID,post,read};
}
test('sharing management reads only eligible records of the current registered role instance',async t=>{
 const f=await fixture(t);
 const draft={kind:'知识',text:'合成知识',source:'测试',citation:'合成引用',version:'1'};
 const added=await f.characters.apply(f.petID,1,{type:'addMemory',value:draft});
 const memory=added.state.memories[0]!.current;
 let response=await f.read();assert.equal(response.statusCode,200);
 assert.equal(response.json().snapshot.petID,f.petID);
 assert.equal(response.json().snapshot.records.length,1);
 assert.equal(response.json().snapshot.records[0].enabled,false);
 await f.characters.apply(f.petID,added.state.revision,{type:'confirmMemory',id:memory.id});
 response=await f.read();const result=response.json();
 assert.equal(result.snapshot.records.length,2);
 assert.match(result.snapshot.records[1].preview,/合成知识/);
 assert.equal(JSON.stringify(result).includes('另一只'),false);
 assert.equal(JSON.stringify(result).includes('chatShare'),false);
});
test('sharing management writes current versions only and rejects stale or mismatched binding intent',async t=>{
 const f=await fixture(t);const record={kind:'identity',recordID:'identity',recordRevision:1};
 const input={role:'longmei',petID:f.petID,bindingRevision:1,expectedRevision:0,records:[record]};
 for(const bad of [{...input,petID:f.otherID},{...input,bindingRevision:0},{...input,path:'/private'}])
  assert.notEqual((await f.post('/v1/live/shares',bad)).statusCode,200);
 assert.equal((await f.shares.read()).grants.length,0);
 let response=await f.post('/v1/live/shares',input);assert.equal(response.statusCode,200);
 assert.equal(response.json().snapshot.records[0].enabled,true);
 assert.equal((await f.characters.read(f.petID)).identity?.chatShare,undefined);
 assert.equal((await f.post('/v1/live/shares',input)).statusCode,409);
 await f.characters.apply(f.petID,1,{type:'saveIdentity',value:{...identity,role:'新版'}});
 assert.equal((await f.read()).json().snapshot.records[0].enabled,false);
 response=await f.post('/v1/live/shares',{...input,expectedRevision:1});assert.notEqual(response.statusCode,200);
});
test('unbinding clears old live grants so rebinding cannot silently restore authorization',async t=>{
 const f=await fixture(t);
 await f.post('/v1/live/shares',{role:'longmei',petID:f.petID,bindingRevision:1,expectedRevision:0,records:[{kind:'identity',recordID:'identity',recordRevision:1}]});
 assert.equal((await f.post('/v1/live/role-bindings',{expectedRevision:1,role:'longmei',petID:null})).statusCode,200);
 assert.equal((await f.read()).statusCode,409);
 assert.equal((await f.post('/v1/live/role-bindings',{expectedRevision:2,role:'longmei',petID:f.petID})).statusCode,200);
 assert.equal((await f.read()).json().snapshot.records[0].enabled,false);
 assert.deepEqual((await f.shares.read()).grants,[]);
});

test('withdrawing confirmation invalidates live sharing and sensitive identities are not offered',async t=>{
 const f=await fixture(t);
 const added=await f.characters.apply(f.petID,1,{type:'addMemory',value:{kind:'偏好',text:'偏好简短回答',source:'合成',citation:'',version:''}});
 const memory=added.state.memories[0]!.current;
 const confirmed=await f.characters.apply(f.petID,added.state.revision,{type:'confirmMemory',id:memory.id});
 let read=(await f.read()).json().snapshot;
 const record=read.records.find((r:{recordID:string})=>r.recordID===memory.id);assert.ok(record);
 const {kind,recordID,recordRevision}=record;
 assert.equal((await f.post('/v1/live/shares',{role:'longmei',petID:f.petID,bindingRevision:1,expectedRevision:read.revision,records:[{kind,recordID,recordRevision}]})).statusCode,200);
 const withdrawn=await f.characters.apply(f.petID,confirmed.state.revision,{type:'withdrawMemory',id:memory.id});
 await f.characters.apply(f.petID,withdrawn.state.revision,{type:'saveIdentity',value:{...identity,background:'合成密码不应出站'}});
 read=(await f.read()).json().snapshot;assert.deepEqual(read.records,[]);
 assert.equal((await f.post('/v1/live/shares',{role:'longmei',petID:f.petID,bindingRevision:1,expectedRevision:read.revision,records:[]})).statusCode,200);
 assert.deepEqual((await f.shares.read()).grants,[]);
});
test('an in-flight grant cannot survive a concurrent unbind and cannot target a replacement instance',async t=>{
 const f=await fixture(t);let release!:()=>void,entered!:()=>void;
 const enteredRead=new Promise<void>(resolve=>{entered=resolve;});const held=new Promise<void>(resolve=>{release=resolve;});
 const read=f.characters.readForOnlineChat.bind(f.characters);
 f.characters.readForOnlineChat=async id=>{entered();await held;return read(id);};
 const grant=f.post('/v1/live/shares',{role:'longmei',petID:f.petID,bindingRevision:1,expectedRevision:0,records:[{kind:'identity',recordID:'identity',recordRevision:1}]}).then(r=>r);
 await enteredRead;const unbind=f.post('/v1/live/role-bindings',{expectedRevision:1,role:'longmei',petID:null}).then(r=>r);
 release();assert.equal((await grant).statusCode,200);assert.equal((await unbind).statusCode,200);
 assert.deepEqual((await f.shares.read()).grants,[]);
 assert.equal((await f.post('/v1/live/role-bindings',{expectedRevision:2,role:'longmei',petID:f.otherID})).statusCode,200);
 assert.equal((await f.post('/v1/live/shares',{role:'longmei',petID:f.petID,bindingRevision:3,expectedRevision:2,records:[{kind:'identity',recordID:'identity',recordRevision:1}]})).statusCode,409);
});
