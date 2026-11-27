import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveLearningSession } from '../src/live-learning-state.ts';
import type { CharacterLearningBridge, CharacterLearningGenerateInput, CharacterLearningGenerateResult } from '../../../packages/contracts/src/character-learning.ts';
const input={petID:'pet-synthetic',ticket:'a'.repeat(48)};
const preview={...input,source:'live' as const,role:'dafeiyu' as const,user:'欢迎轻松一点就好',assistant:'那就轻轻打个招呼吧。',confirmation:'c'.repeat(48),revision:0,expiresAt:Date.now()+60000};
type Bridge=Pick<CharacterLearningBridge,'preview'|'generate'|'cancel'>;
function bridge(overrides:Partial<Bridge>={}):Bridge{return {preview:async()=>({ok:true,preview}),generate:async()=>({ok:true,petID:input.petID,candidateID:'memory-a',revision:1,durability:'confirmed'}),cancel:async()=>({ok:true}),...overrides};}
test('learning needs an explicit selected preview and a separate confirmation; double clicks never duplicate',async()=>{
 const writes:CharacterLearningGenerateInput[]=[];let finish!:(r:CharacterLearningGenerateResult)=>void;
 const session=new LiveLearningSession(bridge({generate:async value=>{writes.push(value);return new Promise(resolve=>{finish=resolve;});}}),'dafeiyu',input);
 await session.confirm();assert.equal(writes.length,0);
 await session.select();assert.equal(session.state.phase,'preview');assert.equal(writes.length,0);
 const saving=session.confirm();await session.confirm();assert.equal(writes.length,1);
 assert.deepEqual(writes[0],{...input,confirmation:preview.confirmation,expectedRevision:0,confirmed:true});
 finish({ok:true,petID:input.petID,candidateID:'memory-a',revision:1,durability:'confirmed'});await saving;
 assert.equal(session.state.phase,'review');assert.equal(session.state.preview,undefined);
 await session.confirm();assert.equal(writes.length,1);
});
test('cancel and disposal erase selected text and reject late results; wrong instance/role cannot be learned',async()=>{
 let finish!:(r:{ok:true;preview:typeof preview})=>void;let cancelled=0;
 const session=new LiveLearningSession(bridge({preview:()=>new Promise(resolve=>{finish=resolve;}),cancel:async()=>{cancelled++;return {ok:true};}}),'dafeiyu',input);
 const selecting=session.select();session.dispose();finish({ok:true,preview});await selecting;
 assert.equal(cancelled,1);assert.equal(session.state.preview,undefined);
 const cross=new LiveLearningSession(bridge({preview:async()=>({ok:true,preview:{...preview,role:'longmei'}})}),'dafeiyu',input);
 await cross.select();assert.equal(cross.state.phase,'failed');
});
test('unknown candidate write never retries automatically and clears the source round',async()=>{
 let calls=0;const session=new LiveLearningSession(bridge({generate:async()=>{calls++;return {ok:false,error:'write-outcome-unknown'};}}),'dafeiyu',input);
 await session.select();await session.confirm();await session.confirm();await session.select();
 assert.equal(calls,1);assert.equal(session.state.phase,'failed');assert.equal(session.state.preview,undefined);
});

test('cancelling an in-flight candidate immediately clears source text and reports uncertain writes',async()=>{
 let finish!:(r:CharacterLearningGenerateResult)=>void;
 const session=new LiveLearningSession(bridge({
   generate:()=>new Promise(resolve=>{finish=resolve;}),cancel:async()=>({ok:false,error:'unavailable'}),
 }),'dafeiyu',input);
 await session.select();const generating=session.confirm();
 const stopped=session.dispose();assert.equal(session.state.phase,'idle');assert.equal(session.state.preview,undefined);
 assert.deepEqual(await stopped,{ok:false,error:'write-outcome-unknown'});
 finish({ok:true,petID:input.petID,candidateID:'memory-a',revision:1,durability:'confirmed'});await generating;
 assert.equal(session.state.phase,'idle');
});
