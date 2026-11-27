import { isLiveRoleId, type LiveRoleId } from '../../../packages/contracts/src/live-stage.ts';
import { isLiveSharingInput, isLiveSharingResult, type LiveSharingInput, type LiveSharingResult } from '../../../packages/contracts/src/live-sharing.ts';
const unavailable={ok:false,error:'unavailable'} as const;
const limit=2*1024*1024;
export async function requestLiveSharing(connection:{port:number;token:string},role:LiveRoleId,input?:LiveSharingInput,fetcher:typeof fetch=fetch):Promise<LiveSharingResult>{
  if(!isLiveRoleId(role)||(input&&(!isLiveSharingInput(input)||input.role!==role)))return unavailable;
  try{
    const response=await fetcher(`http://127.0.0.1:${connection.port}/v1/live/shares${input?'':`?role=${role}`}`,{
      method:input?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(6500),
      headers:{authorization:`Bearer ${connection.token}`,...(input&&{'content-type':'application/json'})},body:input?JSON.stringify(input):undefined,
    });
    if(!response.body||Number(response.headers.get('content-length'))>limit)return unavailable;
    const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();return unavailable;}chunks.push(value);}}finally{reader.releaseLock();}
    const data:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
    if(!isLiveSharingResult(data)||data.ok!==response.ok)return unavailable;
    if(data.ok&&(data.snapshot.role!==role||(input&&(data.snapshot.petID!==input.petID||data.snapshot.bindingRevision!==input.bindingRevision))))return unavailable;
    return data;
  }catch{return unavailable;}
}
