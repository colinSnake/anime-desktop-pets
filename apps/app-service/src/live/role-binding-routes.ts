import type { FastifyInstance } from 'fastify';
import { isLiveRoleId, type LiveRoleId } from '../../../../packages/contracts/src/live-stage.ts';
import { liveRoleForPackage } from '../../../../packages/contracts/src/character-personas.ts';
import type { PetWorkspace } from '../pet-workspace.ts';
import type { LiveRoleBindingStore } from './role-bindings.ts';

const error=(code:'invalid'|'conflict'|'unavailable')=>({ok:false as const,error:code});
export function registerLiveRoleBindings(app:FastifyInstance,store:LiveRoleBindingStore|undefined,workspace:PetWorkspace|undefined){
  const empty={type:'object',additionalProperties:false} as const;
  app.get('/v1/live/role-bindings',{schema:{querystring:empty}},async()=>{
    if(!store)return error('unavailable');
    try{return {ok:true as const,...await store.read()};}catch{return error('unavailable');}
  });
  app.post('/v1/live/role-bindings',{schema:{querystring:empty,body:{type:'object',additionalProperties:false,required:['expectedRevision','role','petID'],properties:{expectedRevision:{type:'integer',minimum:0},role:{type:'string',enum:['longmei','dafeiyu']},petID:{type:['string','null'],maxLength:64}}}},bodyLimit:256},async(request,reply)=>{
    const body=request.body as {expectedRevision:number;role:LiveRoleId;petID:string|null};
    if(!store||!workspace)return reply.code(503).send(error('unavailable'));
    if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0||!isLiveRoleId(body.role)||!(body.petID===null||/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.petID)))return reply.code(400).send(error('invalid'));
    const commit=async()=>{
      try{
        const current=await store.read(); if(current.revision!==body.expectedRevision) throw new Error('conflict');
        const bindings={...current.bindings,[body.role]:body.petID};
        return await store.write(current.revision,bindings);
      }catch(e){throw e;}
    };
    try{
      const result=body.petID===null ? await commit() : await workspace.withRegisteredInstance(body.petID,async(id,instance)=>{
        if(id!==body.petID||liveRoleForPackage(instance.package)!==body.role)throw new Error('invalid');
        return commit();
      });
      return {ok:true,...result};
    }catch(e){
      const message=e instanceof Error?e.message:'';
      if(message.includes('conflict'))return reply.code(409).send(error('conflict'));
      if(message.includes('invalid')||message.includes('not-found'))return reply.code(422).send(error('invalid'));
      return reply.code(503).send(error('unavailable'));
    }
  });
}
