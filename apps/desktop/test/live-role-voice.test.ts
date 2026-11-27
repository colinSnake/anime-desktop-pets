import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultLiveProfile, isLiveSnapshot } from '../../../packages/contracts/src/live-stage.ts';
import { LiveStageClock } from '../src/live-stage/clock.ts';
import { LiveStageController } from '../src/live-stage/controller.ts';

function wav() {
  const bytes = Buffer.alloc(46);
  bytes.write('RIFF'); bytes.writeUInt32LE(38,4); bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16); bytes.writeUInt16LE(1,20); bytes.writeUInt16LE(1,22);
  bytes.writeUInt32LE(24000,24); bytes.writeUInt32LE(48000,28); bytes.writeUInt16LE(2,32);
  bytes.writeUInt16LE(16,34); bytes.write('data',36); bytes.writeUInt32LE(2,40);
  return bytes;
}
const audio = wav();
const bank = {'01':audio,'18':audio,'20':audio};

test('whale clock accepts only explicitly whale-scoped audio and emits valid whale subtitles', () => {
  const clock = new LiveStageClock(defaultLiveProfile(),'dafeiyu');
  clock.setVoice(bank); clock.trigger('companion-wave');
  assert.equal(clock.snapshot().voice,undefined,'legacy Dragon voice is not a Whale reference');
  clock.setVoice(bank,'dafeiyu'); clock.trigger('companion-wave');
  assert.equal(clock.snapshot().voice,true);
  assert.equal(clock.voiceFor(clock.snapshot().generation),audio);
  assert.equal(isLiveSnapshot(clock.snapshot()),true);
  clock.trigger('companion-jump');
  assert.equal(clock.voiceFor(clock.snapshot().generation),audio);
  const idle = new LiveStageClock(defaultLiveProfile(),'dafeiyu');
  idle.setVoice(bank,'dafeiyu');
  assert.equal(idle.publishDanmaku('谢谢你来陪我看海。',audio),true);
  assert.equal(idle.snapshot().action,'companion-wave');
  assert.equal(isLiveSnapshot(idle.snapshot()),true);
  idle.setVoice(); assert.equal(idle.snapshot().voice,undefined);
});

test('stage requests the selected role voice, and late whale audio is revoked after stop', async () => {
  let role: unknown; let signal: AbortSignal | undefined;
  let finish!: (value: {ok:true;clips:typeof bank}) => void;
  const stage = new LiveStageController({
    profile:async()=>({ok:true,profile:defaultLiveProfile()}),allowed:async()=>true,
    open:async()=>({url:'http://127.0.0.1:1234/',close:async()=>{}}),
    preview:async()=>{},closePreview(){},copy(){},
    voice:(input,selected)=>{signal=input;role=selected;return new Promise(resolve=>{finish=resolve;});},
  });
  try {
    const start = await stage.run('start',undefined,()=>true,'dafeiyu');
    assert.ok(start.ok); assert.equal(start.voice,'preparing'); assert.equal(role,'dafeiyu');
    await stage.run('stop',undefined,()=>true,'dafeiyu'); assert.equal(signal?.aborted,true);
    finish({ok:true,clips:bank}); await new Promise(resolve=>setImmediate(resolve));
    const state=await stage.run('read',undefined,()=>true,'dafeiyu');
    assert.ok(state.ok); assert.equal(state.running,false); assert.equal(state.voice,'muted');
  } finally { await stage.close(); }
});

test('voice configuration is blocked throughout stage open and stop transitions', async () => {
  let finish!: () => void;
  const stage = new LiveStageController({
    profile:async()=>({ok:true,profile:defaultLiveProfile()}),allowed:async()=>true,
    open:async()=>{await new Promise<void>(resolve=>{finish=resolve;});return {url:'local',close:async()=>{}};},
    preview:async()=>{},closePreview(){},copy(){},
  });
  assert.equal(stage.canConfigureVoice,true);
  const pending=stage.run('start',undefined,()=>true,'dafeiyu');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(stage.canConfigureVoice,false);
  finish(); await pending; assert.equal(stage.canConfigureVoice,false);
  await stage.stop(); assert.equal(stage.canConfigureVoice,true);
  await stage.close(); assert.equal(stage.canConfigureVoice,false);
});

test('learning handle is only published for the current successful stage reply and revoked on workspace hide', async () => {
  const learning={petID:'pet-synthetic',ticket:'a'.repeat(48),expiresAt:Date.now()+60000};
  const cancelled:unknown[]=[];
  let clock: Parameters<ConstructorParameters<typeof LiveStageController>[0]['open']>[1] | undefined;
  const stage=new LiveStageController({
    profile:async()=>({ok:true,profile:defaultLiveProfile()}),allowed:async()=>true,
    open:async(_role, owned)=>{clock=owned;return {url:'local',close:async()=>{}};},preview:async()=>{},closePreview(){},copy(){},
    voice:async()=>({ok:true,clips:bank}),danmaku:async()=>({ok:true,text:'这句只给节目。',audio,learning}),
    cancelLearning: async input=>{cancelled.push(input);return {ok:true};},
  });
  const run=(method:Parameters<typeof stage.run>[0],input?:unknown)=>stage.run(method,input,()=>true,'dafeiyu');
  try {
    await run('start'); await run('submitDanmaku','你好');await new Promise(resolve=>setImmediate(resolve));
    const ready=await run('read');assert.ok(ready.ok);
    assert.deepEqual(ready.danmaku,{phase:'published',learning});
    assert.equal(stage.ownsLearning({petID:learning.petID,ticket:learning.ticket}),true);
    const generation = clock!.snapshot().generation;
    assert.ok(clock!.voiceFor(generation));
    stage.cancelDanmaku();
    assert.equal(clock!.snapshot().reply,undefined);
    assert.equal(clock!.voiceFor(generation),undefined);
    assert.equal((await run('read') as {running:boolean}).running,true);
    assert.equal(stage.ownsLearning({petID:learning.petID,ticket:learning.ticket}),false);
    assert.deepEqual(cancelled,[{petID:learning.petID,ticket:learning.ticket}]);
  } finally { await stage.close(); }
});

test('management can rediscover a running Whale stage after leaving and reopening the page',async()=>{
  const stage=new LiveStageController({
    profile:async()=>({ok:true,profile:defaultLiveProfile()}),allowed:async()=>true,
    open:async()=>({url:'local',close:async()=>{}}),preview:async()=>{},closePreview(){},copy(){},
  });
  try {
    assert.ok((await stage.run('start',undefined,()=>true,'dafeiyu')).ok);
    const result=await stage.run('read',undefined,()=>true,'longmei');
    assert.ok(result.ok);assert.equal(result.running,true);assert.equal(result.activeRole,'dafeiyu');
    assert.deepEqual(await stage.run('stop',undefined,()=>true,'longmei'),{ok:false,error:'unavailable'});
  } finally {await stage.close();}
});
