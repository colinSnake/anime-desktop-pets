import type { FastifyInstance } from 'fastify';
import { isLiveRoleId, type LiveRoleId } from '../../../../packages/contracts/src/live-stage.ts';
import { credentialLike, credentialLikeText } from '../../../../packages/contracts/src/character-records.ts';
import { identityFields } from '../../../../packages/contracts/src/characters.ts';
import { isLiveSharingInput, type LiveShareRecord, type LiveSharingRow, type LiveSharingSnapshot } from '../../../../packages/contracts/src/live-sharing.ts';
import { liveRoleForPackage } from '../../../../packages/contracts/src/character-personas.ts';
import type { PetWorkspace } from '../pet-workspace.ts';
import type { CharacterRepository } from '../characters/repository.ts';
import type { CharacterState } from '../characters/records.ts';
import type { LiveRoleBindingStore } from './role-bindings.ts';
import type { LiveShareStore, LiveShareSnapshot } from './sharing.ts';

const err=(error:'invalid'|'conflict'|'unavailable'|'unbound')=>({ok:false as const,error});
const matches=(a:LiveShareRecord,b:LiveShareRecord)=>a.kind===b.kind&&a.recordID===b.recordID&&a.recordRevision===b.recordRevision;
function snapshot(role:LiveRoleId,petID:string,bindingRevision:number,state:CharacterState,shares:LiveShareSnapshot):LiveSharingSnapshot {
  const records:LiveSharingRow[]=[];
  const add=(record:LiveShareRecord,label:string,preview:string)=>records.push({...record,label,preview,enabled:shares.grants.some(g=>g.petID===petID&&matches(g,record))});
  if(state.identity){
    const identity=state.identity;
    const values=[identity.name,...identityFields.map(field=>identity[field])];
    if(!credentialLikeText(values.join(' ')))add({kind:'identity',recordID:'identity',recordRevision:identity.revision},'当前身份',values.filter(Boolean).join('\n'));
  }
  for(const {current:m} of state.memories){
    if(m.status!=='confirmed'||credentialLike(m)||(m.expiresAt&&Date.parse(m.expiresAt)<=Date.now()))continue;
    add({kind:'memory',recordID:m.id,recordRevision:m.revision},m.kind,[m.text,m.source,m.citation,m.version].filter(Boolean).join('\n'));
  }
  return {role,petID,bindingRevision,revision:shares.revision,records};
}
export function registerLiveSharing(app:FastifyInstance,store:LiveShareStore|undefined,workspace:PetWorkspace|undefined,characters:CharacterRepository|undefined,bindings:LiveRoleBindingStore|undefined){
  const query={type:'object',additionalProperties:false,required:['role'],properties:{role:{type:'string',enum:['longmei','dafeiyu']}}} as const;
  const empty={type:'object',additionalProperties:false} as const;
  async function manage(role:LiveRoleId,input?:unknown){
    if(!store||!workspace||!characters||!bindings)throw new Error('unavailable');
    const binding=await bindings.read(),petID=binding.bindings[role];
    if(!petID)throw new Error('unbound');
    return workspace.withRegisteredInstance(petID,async(id,instance)=>{
      if(id!==petID||liveRoleForPackage(instance.package)!==role)throw new Error('unbound');
      return store.manage(async()=>{
        const currentBinding=await bindings.read();
        if(currentBinding.revision!==binding.revision||currentBinding.bindings[role]!==id)throw new Error('conflict');
        const state=await characters.readForOnlineChat(id),current=await store.read();
        const view=snapshot(role,id,binding.revision,state,current);
        if(input===undefined)return view;
        if(!isLiveSharingInput(input)||input.role!==role)throw new Error('invalid');
        if(input.petID!==id||input.bindingRevision!==binding.revision||input.expectedRevision!==current.revision)throw new Error('conflict');
        if(input.records.some(record=>!view.records.some(row=>matches(record,row))))throw new Error('invalid');
        const grants=[...current.grants.filter(g=>g.petID!==id),...input.records.map(r=>({petID:id,...r}))];
        const saved=await store.write(current.revision,grants);
        return snapshot(role,id,binding.revision,state,saved);
      });
    });
  }
  const failure=(e:unknown,reply:import('fastify').FastifyReply)=>{
    const message=e instanceof Error?e.message:'';
    if(message.includes('conflict'))return reply.code(409).send(err('conflict'));
    if(message.includes('unbound')||message.includes('not-found'))return reply.code(409).send(err('unbound'));
    if(message.includes('invalid'))return reply.code(422).send(err('invalid'));
    return reply.code(503).send(err('unavailable'));
  };
  app.get('/v1/live/shares',{schema:{querystring:query}},async(req,reply)=>{
    const role=(req.query as {role:unknown}).role;
    if(!isLiveRoleId(role))return reply.code(400).send(err('invalid'));
    try{return {ok:true,snapshot:await manage(role)};}catch(e){return failure(e,reply);}
  });
  app.post('/v1/live/shares',{schema:{querystring:empty},bodyLimit:8192},async(req,reply)=>{
    if(!isLiveSharingInput(req.body))return reply.code(400).send(err('invalid'));
    try{return {ok:true,snapshot:await manage(req.body.role,req.body)};}catch(e){return failure(e,reply);}
  });
}
