import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error The production build helper is an executable JavaScript module.
import { stageLiveUI } from '../../../scripts/stage-live-ui.mjs';
import { defaultLiveProfile, isLiveProfile, isLiveSnapshot, liveActions, liveScenes, validLiveArgs, type LiveProfile } from '../../../packages/contracts/src/live-stage.ts';
import { LiveStageClock } from '../src/live-stage/clock.ts';
import { stageArtworkName } from '../src/live-stage/assets.ts';
import { openStageOutput } from '../src/live-stage/output.ts';

const sceneIds = ['desk-room', 'rain-loft', 'cloud-terrace', 'meadow', 'forest', 'studio'] as const;

test('only six latest scenes, complete scene-specific placement, and fixed calls', () => {
  const p = defaultLiveProfile();
  assert.equal(p.selected, 'desk-room');
  assert.equal(p.schemaVersion, 3);
  assert.deepEqual(liveScenes.map(scene => scene.id), sceneIds);
  assert.deepEqual(p.scenes, {
    'desk-room': {position:50,scale:100}, 'rain-loft': {position:50,scale:100}, 'cloud-terrace': {position:50,scale:100},
    meadow: {position:48,scale:100}, forest: {position:47,scale:100}, studio: {position:47,scale:100},
  });
  const { studio, ...incomplete } = p.scenes;
  assert.equal(isLiveProfile({...p, scenes:incomplete}), false);
  assert.equal(isLiveProfile({...p, scenes:{...p.scenes, forest:{position:75,scale:100}}}), false);
  assert.equal(isLiveSnapshot({protocol:1, scene:'forest', placement:{position:75,scale:100}, generation:0}), false);
  assert.ok(isLiveSnapshot({protocol:1, scene:'studio', placement:studio, generation:0}));
  assert.ok(isLiveProfile(p));
  for (const input of [{...p, path: '/tmp/data'}, {...p, schemaVersion: 1}, {...p, selected: 'morning'}, {...p, scenes: {...p.scenes, 'desk-room': {position: 76, scale: 100}}}]) assert.equal(isLiveProfile(input), false);
  assert.equal(validLiveArgs('start', ['url']), false);
  assert.equal(validLiveArgs('trigger', ['../idle']), false);
  assert.equal(validLiveArgs('trigger', ['01','longmei']), true);
  assert.equal(validLiveArgs('trigger', ['companion-wave','dafeiyu']), true);
  assert.equal(validLiveArgs('trigger', ['companion-wave','longmei']), false);
  for (const id of sceneIds) assert.equal(validLiveArgs('switchScene', [id,'longmei']), true);
  for (const args of [[], ['../rain-loft'], ['rain-loft', 'desk-room'], [defaultLiveProfile()]]) {
    assert.equal(validLiveArgs('switchScene', args), false);
  }
});

test('fixed programme subtitles match the worker voice lines across all scenes', async () => {
  assert.equal(liveActions['01'].line, '嗨，我是龙妹，欢迎来直播间！');
  const worker = await readFile(new URL('../../runtime-bridge/bubble_speech_worker.py', import.meta.url), 'utf8');
  for (const [id, {line}] of Object.entries(liveActions)) assert.ok(worker.includes(`'${id}': '${line}'`));
});

test('latest manual host action wins and expiry does not replay', () => {
  let now = 0;
  const clock = new LiveStageClock(defaultLiveProfile(), () => now);
  assert.equal(clock.snapshot().generation, 0);
  assert.ok(clock.trigger('01'));
  now = 400;
  assert.ok(clock.trigger('20'));
  const snapshot = clock.snapshot();
  assert.equal(snapshot.action, '20');
  assert.equal(snapshot.generation, 2);
  now += 9000;
  assert.equal(clock.snapshot().action, undefined);
  assert.equal(clock.snapshot().generation, 2);
  assert.equal(clock.snapshot().action, undefined);
});

test('loopback output isolates session path, rejects writes and serves bounded byte ranges', async () => {
  const clock = new LiveStageClock(defaultLiveProfile());
  const out = await openStageOutput(clock, new Map([['index.html', {type:'text/html', bytes:Buffer.from('<html>stage</html>')}], ['01.webm', {type:'video/webm', bytes:Buffer.from('0123456789')}]]));
  try {
    const base = new URL(out.url);
    const route = (name: string) => new URL(name,base);
    const state = await fetch(route('state.json'));
    assert.equal(state.status,200); assert.equal(state.headers.get('referrer-policy'),'no-referrer');
    assert.match(state.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.equal((await state.json()).scene, 'desk-room');
    assert.equal((await fetch(route('state.json'),{method:'POST'})).status,405);
    assert.equal((await fetch(route('state.json'),{headers:{Origin:'https://example.invalid'}})).status,403);
    assert.equal((await fetch(route('/stage/wrong/state.json'))).status,404);
    assert.equal((await fetch(route('other.webm'))).status,404);
    let r = await fetch(route('01.webm'),{headers:{Range:'bytes=2-4'}});
    assert.equal(r.status,206); assert.equal(r.headers.get('content-range'),'bytes 2-4/10'); assert.equal(await r.text(),'234');
    r = await fetch(route('01.webm'),{headers:{Range:'bytes=10-12'}}); assert.equal(r.status,416);
  } finally { await out.close(); }
  await assert.rejects(fetch(out.url));
});

test('configuration is frozen while active, and a late output cannot survive pause or close', async () => {
  const { LiveStageController } = await import('../src/live-stage/controller.ts');
  let finish!: (o: {url:string;close():Promise<void>}) => void;
  let opened!: () => void;
  const ready = new Promise<void>(resolve => { opened = resolve; });
  const first = new Promise<{url:string;close():Promise<void>}>(resolve => { finish = resolve; });
  const p = defaultLiveProfile(); let options = p;
  let closes = 0, copies = 0, previews = 0, starts = 0;
  const output = {url:'only-in-main',close:async () => { closes++; }};
  const stage = new LiveStageController({
    profile: async profile => { if (profile) options=structuredClone(profile); return {ok:true,profile:options}; }, allowed:async () => true,
    open:async () => { if (!starts++) { opened(); return first; } return output; }, preview:async () => {previews++;}, closePreview:() => {}, copy:() => {copies++;},
  });
  const eligible = () => true;
  const starting = stage.run('start',undefined,eligible); await ready;
  await stage.stop(); finish(output);
  assert.deepEqual(await starting,{ok:false,error:'unavailable'}); assert.equal(closes,1);
  const running = await stage.run('start',undefined,eligible); assert.ok(running.ok && running.running);
  const altered = {...p, selected:'rain-loft'} as const;
  assert.deepEqual(await stage.run('save',altered,eligible),{ok:false,error:'busy'});
  const copied = await stage.run('copy',undefined,eligible); assert.equal(copies,1); assert.doesNotMatch(JSON.stringify(copied), /only-in-main/);
  assert.equal((await stage.run('preview',undefined,eligible)).ok,true); assert.equal(previews,1);
  await stage.close(); assert.equal(closes,2);
  assert.deepEqual(await stage.run('start',undefined,eligible),{ok:false,error:'unavailable'});
});

test('quit waits for an in-flight start to finish retiring its listener', async () => {
  const { LiveStageController } = await import('../src/live-stage/controller.ts');
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(settle => { resolve = settle; });
    return {promise,resolve};
  };
  const entered = deferred<void>();
  const listener = deferred<{url: string; close(): Promise<void>}>();
  const cleaned = deferred<void>();
  const stage = new LiveStageController({
    profile: async () => ({ok:true,profile:defaultLiveProfile()}), allowed:async () => true,
    open: async () => { entered.resolve(); return listener.promise; },
    preview:async () => {}, closePreview:() => {}, copy:() => {},
  });
  const starting = stage.run('start',undefined,() => true);
  await entered.promise;
  let quitDone = false;
  const quit = stage.close().then(() => { quitDone = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(quitDone,false);
  listener.resolve({url:'unused',close:() => cleaned.promise});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(quitDone,false);
  cleaned.resolve();
  await quit;
  assert.deepEqual(await starting,{ok:false,error:'unavailable'});
});


test('stage package contains the complete local artwork for all six approved scenes', async () => {
  const root = await mkdtemp(join(tmpdir(),'live-scenes-bundle-'));
  const out = join(root,'stage');
  try {
    await stageLiveUI(process.cwd(),out);
    assert.match(await readFile(join(out,'index.html'),'utf8'),/<title>龙妹的直播舞台<\/title>/);
    for (const id of sceneIds) for (const kind of ['room','desk','cover','preview']) {
      const name = `${id}-${kind}.webp`;
      assert.deepEqual(await readFile(join(out,name)),await readFile(join(process.cwd(),'apps/desktop/src/live-stage/art',name)),name);
    }
    assert.equal((await readdir(out)).filter(name => name.endsWith('.webp')).length,24);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('workspace serves only the fixed thumbnails and full-size stage photos, not stage layers or arbitrary files', () => {
  const base = 'pet-app://workspace/live-stage/';
  for (const scene of sceneIds) for (const kind of ['cover', 'preview']) {
    const name = `${scene}-${kind}.webp`;
    assert.equal(stageArtworkName(base + name), name);
  }
  for (const name of ['desk-room-room.webp', 'desk-room-desk.webp', 'forest-room.webp', 'forest-art.svg', 'index.html', 'unknown-preview.webp', 'desk-room-preview.webp?x', 'desk-room-preview.webp#x', '../desk-room-preview.webp', '%64esk-room-preview.webp'])
    assert.equal(stageArtworkName(base + name), undefined, name);
  assert.equal(stageArtworkName('https://workspace/live-stage/desk-room-preview.webp'), undefined);
});


test('running stage confirms a persisted scene on the same program URL without replaying an action', async () => {
  const { LiveStageController } = await import('../src/live-stage/controller.ts');
  let profile = defaultLiveProfile();
  profile.scenes['rain-loft'] = { position: 68, scale: 87 };
  const originalPlacements = structuredClone(profile.scenes);
  let url = '', copied = '', opens = 0, writes = 0, rejectWrite = true;
  let finish!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const saved = new Promise<void>(resolve => { finish = resolve; });
  const stage = new LiveStageController({
    profile: async next => {
      if (next) {
        writes++;
        if (rejectWrite) return {ok:false,error:'storage'};
        entered(); await saved;
        profile = structuredClone(next);
      }
      return {ok:true,profile};
    }, allowed: async () => true,
    open: async (_role,clock) => { opens++; const out = await openStageOutput(clock, new Map()); url = out.url; return out; },
    preview: async () => {}, closePreview: () => {}, copy: value => { copied = value; },
  });
  const eligible = () => true;
  const state = () => fetch(new URL('state.json', url)).then(r => r.json());
  try {
    assert.deepEqual(await stage.run('switchScene','rain-loft',eligible), {ok:false,error:'unavailable'});
    assert.ok((await stage.run('start',undefined,eligible)).ok);
    await stage.run('trigger','20',eligible);
    const before = await state();
    assert.equal(before.scene, 'desk-room'); assert.equal(before.action, '20');
    assert.deepEqual(await stage.run('switchScene','rain-loft',eligible), {ok:false,error:'storage'});
    assert.equal((await state()).scene, 'desk-room');
    rejectWrite = false;
    const switching = stage.run('switchScene','rain-loft',eligible);
    assert.equal(await Promise.race([started.then(() => 'writing'), switching]), 'writing');
    assert.deepEqual(await stage.run('switchScene','cloud-terrace',eligible), {ok:false,error:'busy'});
    assert.equal((await state()).scene, 'desk-room');
    finish();
    assert.deepEqual(await switching, {ok:true,running:true,profile});
    const after = await state();
    assert.equal(after.scene, 'rain-loft'); assert.deepEqual(after.placement, {position:68,scale:87});
    assert.equal(after.generation, before.generation); assert.equal(after.action, before.action);
    assert.ok(after.remainingMs <= before.remainingMs);
    assert.equal(profile.selected, 'rain-loft'); assert.deepEqual(profile.scenes, originalPlacements);
    assert.ok((await stage.run('switchScene','rain-loft',eligible)).ok); assert.equal(writes,2);
    const copy = await stage.run('copy',undefined,eligible);
    assert.equal(copied,url); assert.equal(opens,1); assert.doesNotMatch(JSON.stringify(copy), /127\.0\.0\.1/);
  } finally { finish(); await stage.close(); }
  await assert.rejects(fetch(url));
});

test('new scenes can start directly and switch together with desk scenes on one programme URL', async () => {
  const { LiveStageController } = await import('../src/live-stage/controller.ts');
  let profile: LiveProfile = {...defaultLiveProfile(), selected: 'forest'};
  let url = '', opens = 0;
  const stage = new LiveStageController({
    profile: async next => {
      if (next) profile = structuredClone(next);
      return {ok:true,profile};
    }, allowed: async () => true,
    open: async (_role,clock) => { opens++; const out = await openStageOutput(clock, new Map()); url = out.url; return out; },
    preview: async () => {}, closePreview: () => {}, copy: value => assert.equal(value,url),
  });
  const trusted = () => true;
  try {
    assert.ok((await stage.run('start',undefined,trusted)).ok);
    const state = () => fetch(new URL('state.json',url)).then(response => response.json());
    assert.equal((await state()).scene, 'forest');
    for (const id of ['studio', 'meadow', 'desk-room', 'forest'] as const) {
      assert.ok((await stage.run('switchScene',id,trusted)).ok);
      const current = await state();
      assert.equal(current.scene,id); assert.equal(profile.selected,id);
      assert.deepEqual(current.placement,profile.scenes[id]);
    }
    assert.ok((await stage.run('copy',undefined,trusted)).ok);
    assert.equal(opens,1);
  } finally { await stage.close(); }
});

test('stopping invalidates an in-flight scene change and reports the actually saved profile', async () => {
  const { LiveStageController } = await import('../src/live-stage/controller.ts');
  let profile = defaultLiveProfile();
  let finish!: () => void, entered!: () => void, didClose!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const saved = new Promise<void>(resolve => { finish = resolve; });
  const closed = new Promise<void>(resolve => { didClose = resolve; });
  let opens = 0;
  const stage = new LiveStageController({
    profile: async next => {
      if (next) { entered(); await saved; profile = structuredClone(next); }
      return {ok:true,profile};
    }, allowed: async () => true,
    open: async () => { opens++; return {url:'unused',close:async () => { didClose(); }}; },
    preview: async () => {}, closePreview: () => {}, copy: () => {},
  });
  const eligible = () => true;
  await stage.run('start',undefined,eligible);
  const switching = stage.run('switchScene','rain-loft',eligible);
  assert.equal(await Promise.race([started.then(() => 'writing'), switching]), 'writing');
  const stopping = stage.run('stop',undefined,eligible);
  await closed;
  assert.deepEqual(await stage.run('start',undefined,eligible), {ok:false,error:'busy'});
  finish();
  assert.deepEqual(await switching, {ok:false,error:'unavailable'});
  assert.equal(profile.selected, 'rain-loft');
  assert.deepEqual(await stopping, {ok:true,running:false,profile});
  assert.equal(opens,1);
});

test('program voice is bound to an action generation and revoked without replacing the URL', async () => {
  const { packLiveVoice, parseLiveVoice } = await import('../../../packages/contracts/src/live-voice.ts');
  const wav = Buffer.alloc(44 + 24000 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8,4); wav.write('WAVEfmt ',8); wav.writeUInt32LE(16,16);
  wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22); wav.writeUInt32LE(24000,24); wav.writeUInt32LE(48000,28);
  wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34); wav.write('data',36); wav.writeUInt32LE(wav.length - 44,40);
  const bank = { '01': wav, '18': wav, '20': wav };
  const packed = packLiveVoice(bank);
  assert.deepEqual(parseLiveVoice(packed), bank);
  assert.equal(parseLiveVoice(Buffer.concat([packed,Buffer.from([0])])), undefined);
  const clock = new LiveStageClock(defaultLiveProfile());
  const out = await openStageOutput(clock,new Map());
  const state = () => fetch(new URL('state.json',out.url)).then(r => r.json());
  const clip = (generation: number) => fetch(new URL(`voice-${generation}.wav`,out.url));
  try {
    clock.trigger('01'); assert.equal((await state()).voice,undefined);
    assert.equal((await clip(1)).status,404);
    clock.setVoice(bank); assert.equal((await state()).voice,undefined);
    clock.trigger('18'); assert.equal((await state()).voice,true);
    assert.equal((await clip(1)).status,404);
    const current = await clip(2);
    assert.equal(current.headers.get('content-type'),'audio/wav');
    assert.deepEqual(Buffer.from(await current.arrayBuffer()),wav);
    clock.selectScene('rain-loft'); assert.equal((await state()).voice,true);
    clock.setVoice(); assert.equal((await state()).action,'18'); assert.equal((await state()).voice,undefined);
    assert.equal((await clip(2)).status,404);
    clock.setVoice(bank); assert.equal((await clip(2)).status,404);
  } finally { await out.close(); }
});

test('successful start prepares voice once in the background; stopping aborts it and a late result cannot affect the next stage', async () => {
  const { LiveStageController } = await import('../src/live-stage/controller.ts');
  const jobs: {signal:AbortSignal; finish():void; fail():void}[] = [];
  const clocks: LiveStageClock[] = [];
  let failOpen = true;
  const stage = new LiveStageController({
    profile:async () => ({ok:true,profile:defaultLiveProfile()}), allowed:async () => true,
    open:async (_role,clock) => {
      if (failOpen) throw Error('synthetic media failure');
      clocks.push(clock);
      return {url:'local',close:async()=>{}};
    }, preview:async()=>{}, closePreview:()=>{}, copy:()=>{},
    voice: signal => new Promise(resolve => jobs.push({signal,
      finish:() => resolve({ok:true,clips:{'01':Buffer.alloc(1),'18':Buffer.alloc(1),'20':Buffer.alloc(1)}}),
      fail:() => resolve({ok:false,error:'reference-required'}),
    })),
    danmaku: async () => assert.fail('a stage without ready voice must not call the model'),
  });
  const run = (method: Parameters<typeof stage.run>[0], input?: unknown) => stage.run(method,input,()=>true);
  const voice = async (method: Parameters<typeof stage.run>[0]) => { const result = await run(method); assert.ok(result.ok); return result.voice; };
  try {
    assert.equal(await voice('read'),'muted');
    assert.deepEqual(await run('start'),{ok:false,error:'media'});
    assert.equal(jobs.length,0,'read and failed open never prepare voice');
    failOpen = false;
    assert.equal(await voice('start'),'preparing');
    assert.equal(await voice('read'),'preparing');
    assert.equal(jobs.length,1,'re-reading never starts another preparation');
    assert.deepEqual(await run('submitDanmaku','你好'),{ok:false,error:'unavailable'});
    assert.equal(clocks[0]!.snapshot().action,undefined,'opening never speaks');
    await run('trigger','01');
    assert.equal(clocks[0]!.snapshot().voice,undefined,'manual cues still work silently while voice prepares');
    assert.equal(await voice('stop'),'muted');
    assert.ok(jobs[0]!.signal.aborted);
    assert.equal(await voice('start'),'preparing');
    jobs[0]!.finish();
    await Promise.resolve();
    assert.equal(await voice('read'),'preparing');
    assert.equal(clocks[0]!.snapshot().voice,undefined,'late voice cannot attach after stop');
    jobs[1]!.fail();
    await Promise.resolve();
    assert.equal(await voice('read'),'reference-required');
    const video = await run('read');
    assert.ok(video.ok && video.running,'missing tone does not stop the picture');
    assert.equal(jobs.length,2,'failure is not retried on read');
  } finally { for (const job of jobs) job.fail(); await stage.close(); }
});

test('rehearsal publishes only generated text and its own audio; scene switch preserves the cue and stopping does not cancel a manual action', async () => {
  const { LiveStageController } = await import('../src/live-stage/controller.ts');
  const wav = Buffer.alloc(46);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8,4); wav.write('WAVEfmt ',8); wav.writeUInt32LE(16,16);
  wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22); wav.writeUInt32LE(24000,24); wav.writeUInt32LE(48000,28);
  wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34); wav.write('data',36); wav.writeUInt32LE(wav.length - 44,40);
  let profile = defaultLiveProfile(), url = '';
  const jobs: {signal:AbortSignal; finish(audio?: Buffer):void}[] = [];
  const stage = new LiveStageController({
    profile:async next => ({ok:true,profile:profile = next ?? profile}), allowed:async () => true,
    open:async (_role,clock) => { const out = await openStageOutput(clock,new Map()); url = out.url; return out; },
    preview:async()=>{}, closePreview:()=>{}, copy:()=>{},
    voice:async () => ({ok:true,clips:{'01':wav,'18':wav,'20':wav}}),
    danmaku:async (_role,text,scene,signal,synthesizing) => {
      synthesizing();
      const audio = await new Promise<Buffer|undefined>(resolve => jobs.push({signal,finish:resolve}));
      return audio ? {ok:true,text:`${scene}：${text === '好累' ? '先歇一会吧。' : '这里是雨夜阁楼。'}`,audio} : {ok:false,error:'speech-failed'};
    },
  });
  const run = (method: Parameters<typeof stage.run>[0], input?: unknown) => stage.run(method,input,()=>true);
  const state = () => fetch(new URL('state.json',url)).then(r => r.json());
  const wavURL = (generation: number) => new URL(`voice-${generation}.wav`,url);
  try {
    assert.equal(validLiveArgs('submitDanmaku', ['好累','longmei']),true);
    for (const input of ['', '   ', '话\n话', 'x'.repeat(121), {text:'好累',url:'http://invalid'}]) assert.equal(validLiveArgs('submitDanmaku',[input,'longmei']),false);
    assert.deepEqual(await run('submitDanmaku','好累'),{ok:false,error:'unavailable'});
    await run('start');
    const ready = await run('read'); assert.ok(ready.ok && ready.voice === 'ready');
    assert.equal(jobs.length,0,'opening the stage never submits a rehearsal');
    assert.ok((await run('submitDanmaku','好累')).ok); assert.equal((await state()).reply,undefined);
    assert.deepEqual(await run('submitDanmaku','重复'),{ok:false,error:'busy'});
    await run('switchScene','rain-loft'); jobs[0]!.finish(wav);
    await new Promise(resolve => setImmediate(resolve));
    const aired = await state();
    assert.equal(aired.scene,'rain-loft'); assert.equal(aired.reply,'desk-room：先歇一会吧。');
    assert.deepEqual(Buffer.from(await (await fetch(wavURL(aired.generation))).arrayBuffer()),wav);
    await run('stopDanmaku'); assert.equal((await state()).reply,undefined); assert.equal((await fetch(wavURL(aired.generation))).status,404);
    await run('submitDanmaku','这套叫什么'); jobs[1]!.finish(); await new Promise(resolve => setImmediate(resolve));
    const failed = await run('read'); assert.ok(failed.ok); assert.deepEqual(failed.danmaku,{phase:'failed',error:'speech-failed'});
    assert.equal((await state()).generation,aired.generation);
    await run('submitDanmaku','这套叫什么'); await run('trigger','20');
    assert.ok(jobs[2]!.signal.aborted);
    assert.deepEqual(await run('submitDanmaku','还没收尾'),{ok:false,error:'busy'});
    jobs[2]!.finish(wav); await new Promise(resolve => setImmediate(resolve));
    await run('stopDanmaku');
    const manual = await state(); assert.equal(manual.action,'20'); assert.equal(manual.reply,undefined);
    assert.deepEqual(await run('submitDanmaku','现在的布景叫什么'),{ok:false,error:'busy'});
    assert.equal(jobs.length,3,'a manual cue blocks provider admission');
    assert.equal((await state()).generation,manual.generation);
  } finally { for (const job of jobs) job.finish(); await stage.close(); }
});
