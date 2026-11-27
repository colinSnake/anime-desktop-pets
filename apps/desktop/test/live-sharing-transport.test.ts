import assert from 'node:assert/strict';
import test from 'node:test';
import type {LiveSharingInput} from '../../../packages/contracts/src/live-sharing.ts';
import {requestLiveSharing} from '../src/live-sharing-transport.ts';
const connection={port:19276,token:'a'.repeat(64)};
const input:LiveSharingInput={role:'longmei',petID:'pet-synthetic',bindingRevision:1,expectedRevision:0,records:[]};
const reply={ok:true,snapshot:{role:'longmei',petID:'pet-synthetic',bindingRevision:1,revision:0,records:[]}};
test('live sharing transport uses fixed authenticated loopback endpoints and forwards only the selected scope',async()=>{
 const fetcher:typeof fetch=async(url,init)=>{
  assert.equal(String(url),'http://127.0.0.1:19276/v1/live/shares?role=longmei');
  assert.equal(init?.method,'GET');assert.equal((init?.headers as Record<string,string>).authorization,`Bearer ${connection.token}`);
  return Response.json(reply);
 };
 assert.deepEqual(await requestLiveSharing(connection,'longmei',undefined,fetcher),reply);
 let calls=0;
 const write:typeof fetch=async(url,init)=>{calls++;assert.equal(String(url),'http://127.0.0.1:19276/v1/live/shares');assert.equal(init?.method,'POST');assert.deepEqual(JSON.parse(String(init?.body)),input);throw new Error('lost acknowledgement');};
 assert.deepEqual(await requestLiveSharing(connection,'longmei',input,write),{ok:false,error:'unavailable'});assert.equal(calls,1);
});
test('live sharing transport rejects injected capabilities, foreign replies and oversized responses',async()=>{
 let calls=0;const fetcher:typeof fetch=async()=>{calls++;return Response.json(reply);};
 assert.equal((await requestLiveSharing(connection,'longmei',{...input,path:'/private'} as never,fetcher)).ok,false);assert.equal(calls,0);
 assert.equal((await requestLiveSharing(connection,'dafeiyu',undefined,fetcher)).ok,false);
 assert.equal((await requestLiveSharing(connection,'longmei',undefined,async()=>new Response('x'.repeat(2_097_153)))).ok,false);
 assert.equal((await requestLiveSharing(connection,'longmei',input,async()=>Response.json({...reply,snapshot:{...reply.snapshot,petID:'pet-other'}}))).ok,false);
});
