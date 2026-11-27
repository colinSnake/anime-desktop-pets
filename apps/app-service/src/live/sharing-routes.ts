import type {FastifyInstance} from 'fastify';import {isLiveRoleId,type LiveRoleId} from '../../../../packages/contracts/src/live-stage.ts';import {recordID} from '../../../../packages/contracts/src/character-records.ts';import {liveRoleForPackage} from '../../../../packages/contracts/src/character-personas.ts';import type {PetWorkspace} from '../pet-workspace.ts';import type {CharacterRepository} from '../characters/repository.ts';import type {LiveRoleBindingStore} from './role-bindings.ts';import type {LiveShareStore,LiveShareGrant} from './sharing.ts';
const err=(error:'invalid'|'conflict'|'unavailable'|'unbound')=>({ok:false as const,error});
export function registerLiveSharing(app:FastifyInstance,store:LiveShareStore|undefined,workspace:PetWorkspace|undefined,characters:CharacterRepository|undefined,bindings:LiveRoleBindingStore|undefined){
 const empty={type:'object',additionalProperties:false} as const;
 app.get('/v1/live/shares',{schema:{querystring:empty}},async()=>{if(!store)return err('unavailable');try{return {ok:true,...await store.read()};}catch{return err('unavailable');}});
 const bodySchema={type:'object',additionalProperties:false,required:['expectedRevision','role','records'],properties:{
  expectedRevision:{type:'integer',minimum:0},role:{type:'string',enum:['longmei','dafeiyu']},
  records:{type:'array',maxItems:40,items:{type:'object',additionalProperties:false,required:['kind','recordID','recordRevision'],properties:{
   kind:{type:'string',enum:['identity','memory']},recordID:{type:'string',maxLength:36},recordRevision:{type:'integer',minimum:1}
  }}}
 }};
 app.post('/v1/live/shares',{schema:{querystring:empty,body:bodySchema},bodyLimit:4096},async(req,reply)=>{
  const body=req.body as {expectedRevision:number;role:LiveRoleId;records:Array<{kind:'identity'|'memory';recordID:string;recordRevision:number}>};
  if(!store||!workspace||!characters||!bindings)return reply.code(503).send(err('unavailable'));
  if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0||!isLiveRoleId(body.role)||!Array.isArray(body.records)||body.records.length>40||body.records.some(r=>!r||!((r.kind==='identity'&&r.recordID==='identity')||(r.kind==='memory'&&recordID(r.recordID)))||!Number.isSafeInteger(r.recordRevision)||r.recordRevision<1)||new Set(body.records.map(r=>`${r.kind}:${r.recordID}`)).size!==body.records.length)return reply.code(400).send(err('invalid'));
  try{
   const bound=(await bindings.read()).bindings[body.role];if(!bound)return reply.code(409).send(err('unbound'));
   const result=await workspace.withRegisteredInstance(bound,async(id,instance)=>{
    if(id!==bound||liveRoleForPackage(instance.package)!==body.role)throw new Error('unbound');
    const state=await characters.readForOnlineChat(id);
    for(const grant of body.records){
     if(grant.kind==='identity'){if(!state.identity||state.identity.revision!==grant.recordRevision)throw new Error('invalid');}
     else {const memory=state.memories.find(row=>row.current.id===grant.recordID)?.current;if(!memory||memory.status!=='confirmed'||memory.revision!==grant.recordRevision||(memory.expiresAt&&Date.parse(memory.expiresAt)<=Date.now()))throw new Error('invalid');}
    }
    const current=await store.read();if(current.revision!==body.expectedRevision)throw new Error('conflict');
    const keep=current.grants.filter(g=>g.petID!==id);const next:LiveShareGrant[]=body.records.map(r=>({petID:id,...r}));
    return store.write(current.revision,[...keep,...next]);
   });return {ok:true,...result};
  }catch(e){const code=e instanceof Error?e.message:'';if(code.includes('conflict'))return reply.code(409).send(err('conflict'));if(code.includes('unbound')||code.includes('not-found'))return reply.code(409).send(err('unbound'));if(code.includes('invalid'))return reply.code(422).send(err('invalid'));return reply.code(503).send(err('unavailable'));}
 });
}
