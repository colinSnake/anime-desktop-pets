import assert from 'node:assert/strict';
import test from 'node:test';
import { requestCharacterLearning } from '../src/character-learning-transport.ts';
const input={petID:'pet-synthetic',ticket:'a'.repeat(48)};
const connection={port:1234,token:'b'.repeat(64)};
const preview={...input,source:'live',role:'dafeiyu',user:'你好',assistant:'一起看海吧。',confirmation:'c'.repeat(48),revision:0,expiresAt:Date.now()+60000};
const fake=(data:unknown,status=200):typeof fetch=>async()=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
test('learning transport accepts only fixed ticket inputs and matching instance responses',async()=>{
 assert.deepEqual(await requestCharacterLearning(connection,'preview',input,fake({ok:true,preview})),{ok:true,preview});
 for(const change of [{petID:'pet-other'},{ticket:'d'.repeat(48)}])assert.deepEqual(await requestCharacterLearning(connection,'preview',input,fake({ok:true,preview:{...preview,...change}})),{ok:false,error:'unavailable'});
 let calls=0;const fetcher:typeof fetch=async()=>{calls++;return new Response('{}');};
 await requestCharacterLearning(connection,'preview',{...input,text:'arbitrary context'} as typeof input,fetcher);
 assert.equal(calls,0);
 assert.deepEqual(await requestCharacterLearning(connection,'generate',{...input,confirmation:'c'.repeat(48),confirmed:true,expectedRevision:0},fake({ok:true,petID:'pet-other',candidateID:'memory-a',revision:1,durability:'confirmed'})),{ok:false,error:'unavailable'});
});
test('learning transport rejects oversized, extra-field, and HTTP-inconsistent replies',async()=>{
 assert.deepEqual(await requestCharacterLearning(connection,'preview',input,fake({ok:true,preview,secret:'not allowed'})),{ok:false,error:'unavailable'});
 assert.deepEqual(await requestCharacterLearning(connection,'preview',input,fake({ok:true,preview},503)),{ok:false,error:'unavailable'});
 assert.deepEqual(await requestCharacterLearning(connection,'preview',input,fake({ok:false,error:'expired'},410)),{ok:false,error:'expired'});
 assert.deepEqual(await requestCharacterLearning(connection,'preview',input,fake('x'.repeat(20000))),{ok:false,error:'unavailable'});
});

test('revoking a learning ticket aborts its owned generating request and lost acknowledgement is not success', async () => {
 const { CharacterLearningRequests } = await import('../src/character-learning-transport.ts');
 let signal: AbortSignal | undefined, finish!: () => void;
 const requests=new CharacterLearningRequests(async () => ({ok:false,error:'unavailable'}));
 const confirmed={...input,confirmation:'c'.repeat(48),expectedRevision:0,confirmed:true as const};
 const generating=requests.generate(confirmed, owned=>{signal=owned;return new Promise(resolve=>{finish=()=>resolve({ok:true,petID:input.petID,candidateID:'memory-a',revision:1,durability:'confirmed'});});});
 assert.equal(signal?.aborted,false);
 assert.deepEqual(await requests.generate(confirmed,async()=>assert.fail('duplicate dispatch')),{ok:false,error:'busy'});
 assert.deepEqual(await requests.cancel({petID:'pet-other',ticket:input.ticket}),{ok:false,error:'unavailable'});
 assert.equal(signal?.aborted,false);
 assert.deepEqual(await requests.cancel(input),{ok:false,error:'write-outcome-unknown'});
 assert.equal(signal?.aborted,true);
 finish();assert.deepEqual(await generating,{ok:false,error:'write-outcome-unknown'});
});
