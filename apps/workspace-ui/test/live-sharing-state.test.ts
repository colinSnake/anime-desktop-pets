import assert from 'node:assert/strict';
import test from 'node:test';
import {LiveSharingSession} from '../src/live-sharing-state.ts';
import type {LiveSharingInput,LiveSharingResult} from '../../../packages/contracts/src/live-sharing.ts';
const row={kind:'identity',recordID:'identity',recordRevision:1,label:'当前身份',preview:'合成人格',enabled:false} as const;
const snapshot={role:'longmei',petID:'pet-synthetic',bindingRevision:1,revision:0,records:[row]} as const;
const success:LiveSharingResult={ok:true,snapshot:{...snapshot,records:[row]}};
test('sharing session writes only the displayed instance versions and never retries an unknown result',async()=>{
 const writes:LiveSharingInput[]=[];let answer:LiveSharingResult={ok:false,error:'unavailable'};
 const bridge={readShares:async()=>success,writeShares:async(input:LiveSharingInput)=>{writes.push(input);return answer;}};
 const session=new LiveSharingSession(bridge,'longmei','pet-synthetic');await session.load();
 assert.equal(session.state.phase,'ready');
 await session.set(row,true);assert.equal(session.state.phase,'needs-read');assert.equal(writes.length,1);
 assert.deepEqual(writes[0],{role:'longmei',petID:'pet-synthetic',bindingRevision:1,expectedRevision:0,records:[{kind:'identity',recordID:'identity',recordRevision:1}]});
 await session.set(row,true);assert.equal(writes.length,1);
 await session.load();answer={ok:true,snapshot:{...snapshot,revision:1,records:[{...row,enabled:true}]}};
 await session.set(row,true);assert.equal(session.state.snapshot?.records[0]?.enabled,true);
 answer={ok:true,snapshot:{...snapshot,revision:2,records:[row]}};await session.set({...row,enabled:true},false);
 assert.deepEqual(writes[2]?.records,[]);
});
test('sharing session ignores late reads after disposal and rejects a changed binding',async()=>{
 let finish!:(r:LiveSharingResult)=>void;
 const session=new LiveSharingSession({readShares:()=>new Promise(resolve=>{finish=resolve;}),writeShares:async()=>success},'longmei','pet-synthetic');
 const load=session.load();session.dispose();finish(success);await load;assert.equal(session.state.snapshot,undefined);
 const other=new LiveSharingSession({readShares:async()=>({...success,ok:true,snapshot:{...snapshot,petID:'pet-other',records:[row]}}),writeShares:async()=>success},'longmei','pet-synthetic');
 await other.load();assert.equal(other.state.phase,'needs-read');assert.equal(other.state.snapshot,undefined);
});
test('sharing session serializes clicks and does not accept an acknowledgement for different records',async()=>{
 let finish!:(r:LiveSharingResult)=>void;let count=0;
 const session=new LiveSharingSession({readShares:async()=>success,writeShares:()=>{count++;return new Promise(resolve=>{finish=resolve;});}},'longmei','pet-synthetic');
 await session.load();const write=session.set(row,true);await session.set(row,true);assert.equal(count,1);
 finish({ok:true,snapshot:{...snapshot,revision:1,records:[row]}});await write;assert.equal(session.state.phase,'needs-read');
});
