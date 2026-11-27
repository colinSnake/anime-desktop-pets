import { isAbsolute } from 'node:path';
import { isLiveVoiceProfileTarget, isLiveVoiceProfileMutation, isLiveVoiceTranscriptInput, isLiveVoiceProfileResult, type LiveVoiceProfileResult, type LiveVoiceProfileTarget } from '../../../packages/contracts/src/live-voice-profile.ts';
export const liveVoiceProfileMethods = ['read','select-reference','transcript','clear-reference'] as const;
export type VoiceProfileMethod = typeof liveVoiceProfileMethods[number];
export const liveVoiceProfileChannel = (method:VoiceProfileMethod) => `pet:live-voice-profile-${method}`;
const unavailable={ok:false,error:'unavailable'} as const;
export function validVoiceProfileInput(method:VoiceProfileMethod,input:unknown):input is LiveVoiceProfileTarget {
 return method==='read'?isLiveVoiceProfileTarget(input):method==='transcript'?isLiveVoiceTranscriptInput(input):isLiveVoiceProfileMutation(input);
}
export async function requestLiveVoiceProfile(connection:{port:number;token:string},method:VoiceProfileMethod,input:unknown,path?:string,fetcher:typeof fetch=fetch,signal?:AbortSignal):Promise<LiveVoiceProfileResult>{
  if(!liveVoiceProfileMethods.includes(method)||!validVoiceProfileInput(method,input)||
     (method==='select-reference'?(typeof path!=='string'||!isAbsolute(path)||path.length>4096||path.includes('\0')||!/\.wav$/i.test(path)):path!==undefined))return unavailable;
  try{
    const timeout=AbortSignal.timeout(6500);
    const response=await fetcher(`http://127.0.0.1:${connection.port}/v1/live/voice-profile/${method}`,{
      method:'POST',body:JSON.stringify({...input,...(path!==undefined&&{path})}),redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout,
      headers:{authorization:`Bearer ${connection.token}`,'content-type':'application/json'},
    });
    const limit=24*1024;
    if(!response.headers.get('content-type')?.startsWith('application/json')||!response.body||Number(response.headers.get('content-length'))>limit){await response.body?.cancel();return unavailable;}
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();return unavailable;}chunks.push(value);}}finally{reader.releaseLock();}
    const result:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
    if(signal?.aborted||!isLiveVoiceProfileResult(result)||response.ok!==result.ok)return unavailable;
    if(result.ok&&(result.profile.role!==input.role||result.profile.petID!==input.petID||result.profile.bindingRevision!==input.bindingRevision))return unavailable;
    return result;
  }catch{return unavailable;}
}
