import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile, writeFile, stat, symlink, unlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveProfileStore } from '../src/live/profile.ts';
import { defaultLiveProfile } from '../../../packages/contracts/src/live-stage.ts';

test('stage profile uses the fixed filename for v2 and does not auto-migrate v1', {skip: process.platform === 'win32'}, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'stage-profile-'));
  try {
    const dir = join(root, 'live'), file = join(dir, 'stage-profile.json');
    const retired = join(dir, 'stage-profile-v2.json');
    await mkdir(dir, {mode:0o700});
    const store = new LiveProfileStore(dir);
    const defaults = await store.read();
    assert.deepEqual(defaults, defaultLiveProfile());
    assert.equal(defaults.schemaVersion, 2);
    assert.equal(Object.keys(defaults.scenes).length, 6);

    const oldContents = JSON.stringify({schemaVersion:1,selected:'rain-loft',scenes:{
      'desk-room':{position:50,scale:100}, 'rain-loft':{position:70,scale:110}, 'cloud-terrace':{position:50,scale:100},
    }});
    await writeFile(file, oldContents, {mode:0o600});
    await assert.rejects(store.read());
    assert.equal(await readFile(file,'utf8'),oldContents);
    await unlink(file);

    const p = defaultLiveProfile(); p.selected = 'studio'; p.scenes.studio.scale = 106; p.scenes.forest.position = 38;
    await store.write(p);
    assert.deepEqual(await new LiveProfileStore(dir).read(), p);
    assert.deepEqual(JSON.parse(await readFile(file,'utf8')), p);
    await assert.rejects(readFile(retired));
    assert.equal((await stat(file)).mode & 0o777, 0o600);

    await writeFile(file, '{"schemaVersion":2}');
    await assert.rejects(store.write(p));
    assert.equal(await readFile(file,'utf8'), '{"schemaVersion":2}');
    await unlink(file); await symlink(join(root,'other'),file);
    await assert.rejects(store.read()); await assert.rejects(store.write(p));
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('stage configuration is private, fixed-shape, and read-only while linkage is paused', {skip: process.platform === 'win32'}, async t => {
  const { createService } = await import('../src/server.ts');
  const { PetWorkspace } = await import('../src/pet-workspace.ts');
  const root = await mkdtemp(join(await realpath(tmpdir()), 'stage-profile-route-'));
  const token = 'd'.repeat(64);
  const snapshot = () => ({kind:'diagnostic',status:'idle',detail:''} as const);
  const workspace = new PetWorkspace({root:join(root,'workspace'), catalog:[]});
  const app = createService({token,workspace,liveProfile:new LiveProfileStore(join(root,'live')),
    runtime:{snapshot,probe:async () => snapshot(),close:async () => {}}});
  t.after(async () => { try { await app.close(); } finally { await rm(root,{recursive:true,force:true}); } });
  const url = '/v1/live/stage-profile';
  const headers = {host:'127.0.0.1',authorization:`Bearer ${token}`};
  assert.equal((await app.inject({url,headers:{host:'127.0.0.1'}})).statusCode,401);
  assert.equal((await app.inject({url,headers:{...headers,origin:'https://example.invalid'}})).statusCode,403);
  assert.equal((await app.inject({url:`${url}?path=a`,headers})).statusCode,400);
  const p = defaultLiveProfile(); p.selected = 'rain-loft'; p.scenes['rain-loft'].position = 64;
  const write = (payload: object) => app.inject({method:'POST', url, headers, payload});
  assert.equal((await write({...p,path:'a'})).statusCode,400);
  assert.deepEqual((await write(p)).json(),{ok:true,profile:p});
  assert.ok((await workspace.mutate('pause',{expectedRevision:0})).ok);
  assert.deepEqual((await write(defaultLiveProfile())).json(),{ok:false,error:'busy'});
  assert.deepEqual((await app.inject({url,headers})).json(),{ok:true,profile:p});
});

test('stage voice route accepts only a fixed authenticated request and returns only bounded audio', {skip: process.platform === 'win32'}, async t => {
  const { createService } = await import('../src/server.ts');
  const { PetWorkspace } = await import('../src/pet-workspace.ts');
  const { BubbleSpeech } = await import('../src/speech/bubble-speech.ts');
  const { parseLiveVoice } = await import('../../../packages/contracts/src/live-voice.ts');
  const root = await mkdtemp(join(await realpath(tmpdir()),'stage-voice-route-'));
  const wav = Buffer.alloc(44 + 48000);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8,4); wav.write('WAVEfmt ',8); wav.writeUInt32LE(16,16);
  wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22); wav.writeUInt32LE(24000,24); wav.writeUInt32LE(48000,28);
  wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34); wav.write('data',36); wav.writeUInt32LE(wav.length - 44,40);
  const reference = join(root,'private.wav'); await writeFile(reference,wav);
  const token = 'd'.repeat(64);
  let calls = 0;
  const speech = new BubbleSpeech({run:async () => assert.fail('no desktop audio'), close:async()=>{},
    renderStage: async () => { calls++; return {'01':wav,'18':wav,'20':wav}; }});
  const snapshot = () => ({kind:'diagnostic',status:'idle',detail:''} as const);
  const workspace = new PetWorkspace({root:join(root,'workspace'), catalog:[]});
  const app = createService({token,workspace,speech,liveProfile:new LiveProfileStore(join(root,'live')),
    runtime:{snapshot,probe:async () => snapshot(),close:async () => {}}});
  t.after(async () => { try { await app.close(); } finally { await rm(root,{recursive:true,force:true}); } });
  const url = '/v1/live/voice';
  const headers = {host:'127.0.0.1',authorization:`Bearer ${token}`};
  assert.equal((await app.inject({method:'POST',url,headers:{host:'127.0.0.1'},payload:{}})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url,headers:{...headers,origin:'http://localhost'},payload:{}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:`${url}?path=a`,headers,payload:{}})).statusCode,400);
  const post = (payload: object = {}) => app.inject({method:'POST',url,headers,payload});
  assert.equal((await post({text:'不接受任意台词'})).statusCode,400);
  assert.equal((await post()).statusCode,422); assert.equal(calls,0);
  assert.ok((await speech.select(reference)).ok);
  assert.ok((await speech.saveTranscriptDraft('仅本机合成夹具')).ok);
  const response = await post();
  assert.equal(response.statusCode,200); assert.equal(response.headers['content-type'],'application/octet-stream');
  assert.deepEqual(parseLiveVoice(response.rawPayload),{'01':wav,'18':wav,'20':wav});
  assert.equal(speech.status().state,'disabled');
  assert.ok((await workspace.mutate('pause',{expectedRevision:0})).ok);
  assert.equal((await post()).statusCode,409); assert.equal(calls,1);
});
