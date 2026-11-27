import { packLiveVoice } from '../../../../packages/contracts/src/live-voice.ts';
import type { BubbleSpeech } from '../speech/bubble-speech.ts';
import type { FastifyInstance } from 'fastify';
import { isLiveProfile,isLiveRoleId,type LiveRoleId,type LiveProfile,type LiveProfileResult } from '../../../../packages/contracts/src/live-stage.ts';
import { liveRoleForPackage } from '../../../../packages/contracts/src/character-personas.ts';
import type { LiveProfileStore } from './profile.ts';
import type { LiveRoleBindingStore } from './role-bindings.ts';import type {PetWorkspace} from '../pet-workspace.ts';

export function registerLiveProfile(app:FastifyInstance,store:LiveProfileStore|undefined,available:(role:LiveRoleId)=>boolean|Promise<boolean>,workspace?:PetWorkspace,bindings?:LiveRoleBindingStore){
 const querystring={type:'object',additionalProperties:false,required:['role'],properties:{role:{type:'string',enum:['longmei','dafeiyu']}}} as const;
 const unavailable={ok:false,error:'unavailable'} as const;
 const params=(request: {query:unknown})=>{const q=request.query as {role?:unknown};return isLiveRoleId(q.role)?q.role:undefined;};
 const access=async(role:LiveRoleId,operation:(id:string)=>Promise<LiveProfileResult>):Promise<LiveProfileResult>=>{
  if(!store||!workspace||!bindings)return unavailable;let result:LiveProfileResult=unavailable;
  try{const id=(await bindings.read()).bindings[role];if(!id)return {ok:false,error:'unbound'};await workspace.withRegisteredInstance(id,async(instanceID,instance)=>{if(instanceID!==id)throw new Error('binding');if(liveRoleForPackage(instance.package)!==role){result={ok:false,error:'role-mismatch'};return;}result=await operation(id);});return result;}
  catch{return unavailable;}
 };
 app.get('/v1/live/stage-profile',{schema:{querystring}},async(request,reply):Promise<LiveProfileResult>=>{const role=params(request);if(!role){reply.code(400);return unavailable;}const r=await access(role,async()=>{try{return {ok:true,profile:await store!.read(role)};}catch{return {ok:false,error:'storage'};}});if(!r.ok)reply.code(r.error==='unbound'||r.error==='role-mismatch'?409:503);return r;});
 app.post('/v1/live/stage-profile',{schema:{querystring},bodyLimit:2048},async(request,reply):Promise<LiveProfileResult>=>{const role=params(request);if(!role||!isLiveProfile(request.body)){reply.code(400);return unavailable;}if(!await available(role))return {ok:false,error:'busy'};const r=await access(role,async()=>{try{return {ok:true,profile:await store!.write(request.body as LiveProfile,role)};}catch{return {ok:false,error:'storage'};}});if(!r.ok)reply.code(r.error==='unbound'||r.error==='role-mismatch'?409:503);return r;});
}

export function registerLiveVoice(app:FastifyInstance,speech:BubbleSpeech|undefined,allowed:()=>boolean){const empty={type:'object',additionalProperties:false} as const;app.post('/v1/live/voice',{bodyLimit:64,schema:{querystring:empty,body:empty}},async(_request,reply)=>{reply.header('cache-control','no-store');if(!speech)return reply.code(503).send();const controller=new AbortController();const cancel=()=>controller.abort();reply.raw.once('close',cancel);try{const result=await speech.prepareStageVoice(controller.signal,allowed);if(!result.ok)return reply.code(result.error==='voice-busy'?409:result.error==='reference-required'?422:503).send();return reply.type('application/octet-stream').send(packLiveVoice(result.clips));}catch{return reply.code(503).send();}finally{reply.raw.removeListener('close',cancel);}});}
