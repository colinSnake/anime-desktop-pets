import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { longmei, dafeiyu } from '../../../packages/contracts/src/built-in-pets.ts';
import { isLiveVoiceProfileTarget, isLiveVoiceProfileMutation, isLiveVoiceTranscriptInput, isLiveVoiceProfileResult, type LiveVoiceProfileTarget } from '../../../packages/contracts/src/live-voice-profile.ts';
import { LiveVoiceProfileStore } from '../src/live/voice-profiles.ts';
import { registerLiveVoiceProfileRoutes } from '../src/live/voice-profile-routes.ts';
import { LiveRoleBindingStore } from '../src/live/role-bindings.ts';
import { PetWorkspace } from '../src/pet-workspace.ts';
import { BubbleSpeech } from '../src/speech/bubble-speech.ts';

function wav(marker = 0) {
  const bytes = Buffer.alloc(44 + 48000);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40); bytes.writeInt16LE(marker, 44);
  return bytes;
}
async function fixture(t: TestContext, stopAdditional?: () => Promise<boolean>) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'live-voice-test-'));
  const liveRoot = join(root, 'live');
  const workspace = new PetWorkspace({ root: join(root, 'workspace'), stopAdditional, catalog: [{ ...longmei, name: '龙妹' }, { ...dafeiyu, name: '鲸鱼妹' }] });
  const pets: string[] = [];
  for (const [index, pack] of [longmei, longmei, dafeiyu].entries()) {
    const result = await workspace.mutate('add', { expectedRevision: index, package: pack });
    assert.ok(result.ok); pets.push(result.workspace.instances.find(row => !pets.includes(row.id))!.id);
  }
  const [petID, otherID, whaleID] = pets as [string, string, string];
  const bindings = new LiveRoleBindingStore(liveRoot);
  await bindings.write(0, { longmei: petID, dafeiyu: whaleID });
  const store = new LiveVoiceProfileStore(liveRoot, { workspace, bindings });
  const target: LiveVoiceProfileTarget = { role: 'longmei', petID, bindingRevision: 1 };
  const whale: LiveVoiceProfileTarget = { role: 'dafeiyu', petID: whaleID, bindingRevision: 1 };
  const path = join(root, 'chosen.wav'); await writeFile(path, wav());
  t.after(async () => { await store.close(); await bindings.close(); await workspace.close(); await rm(root, { recursive: true, force: true }); });
  const selected = async () => {
    const result = await store.selectReference({ ...target, expectedRevision: 0 }, path); assert.ok(result.ok); return result.profile;
  };
  const ready = async () => { await selected(); const result = await store.saveTranscript({ ...target, expectedRevision: 1, referenceTranscript: '用户明确选择的测试音色' }); assert.ok(result.ok); return result.profile; };
  return { root, liveRoot, workspace, bindings, store, target, whale, otherID, path, selected, ready };
}

test('voice contracts are exact, path-free, versioned and validate readiness consistently', () => {
  const target = { role: 'longmei', petID: 'pet-one', bindingRevision: 1 };
  const input = { ...target, expectedRevision: 0 };
  assert.ok(isLiveVoiceProfileTarget(target)); assert.ok(isLiveVoiceProfileMutation(input));
  for (const value of [{ ...target, path: '/private' }, { ...target, petID: '../other' }, { ...target, bindingRevision: 1.5 }, { ...target, role: 'other' }]) assert.equal(isLiveVoiceProfileTarget(value), false);
  assert.equal(isLiveVoiceProfileMutation({ ...input, path: '/private' }), false);
  assert.ok(isLiveVoiceTranscriptInput({ ...input, referenceTranscript: '' }));
  assert.equal(isLiveVoiceTranscriptInput({ ...input, referenceTranscript: '字'.repeat(1366) }), false);
  assert.equal(isLiveVoiceTranscriptInput({ ...input, referenceTranscript: '\u0000' }), false);
  const profile = { ...target, revision: 0, hasReference: false, referenceTranscript: '', ready: false };
  assert.ok(isLiveVoiceProfileResult({ ok: true, profile }));
  assert.equal(isLiveVoiceProfileResult({ ok: true, profile: { ...profile, ready: true } }), false);
  assert.equal(isLiveVoiceProfileResult({ ok: true, profile: { ...profile, path: '/private' } }), false);
  assert.equal(isLiveVoiceProfileResult({ ok: false, error: '/private' }), false);
  assert.equal(isLiveVoiceProfileResult({ ok: false, error: ['invalid'] }), false);
});

test('profiles persist private WAV plus transcript only for the explicitly selected bound instance', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.store.read(f.target), { ok: true, profile: { ...f.target, revision: 0, hasReference: false, referenceTranscript: '', ready: false } });
  assert.equal((await f.selected()).ready, false);
  const ready = await f.store.saveTranscript({ ...f.target, expectedRevision: 1, referenceTranscript: '合成参考逐字稿' });
  assert.ok(ready.ok); assert.equal(ready.profile.ready, true); assert.equal(ready.profile.revision, 2);
  const whale = await f.store.read(f.whale); assert.ok(whale.ok); assert.equal(whale.profile.hasReference, false);
  const directory = join(f.liveRoot, 'voices', f.target.petID);
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  const files = await readdir(directory), audio = files.find(name => name.endsWith('.wav'));
  assert.ok(audio); assert.deepEqual(await readFile(join(directory, audio)), wav());
  for (const file of files) assert.equal((await lstat(join(directory, file))).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(ready).includes(f.root), false);
  const reopened = new LiveVoiceProfileStore(f.liveRoot, { workspace: f.workspace, bindings: f.bindings }); t.after(() => reopened.close());
  assert.deepEqual(await reopened.read(f.target), ready);
  const current = await f.bindings.read(); await f.bindings.write(current.revision, { ...current.bindings, longmei: f.otherID });
  const other = await f.store.read({ ...f.target, petID: f.otherID, bindingRevision: 2 }); assert.ok(other.ok); assert.equal(other.profile.hasReference, false);
});

test('mutations require exact profile and binding revisions, clear is durable, selecting a new sample resets transcript', async t => {
  const f = await fixture(t); await f.ready();
  assert.deepEqual(await f.store.clearReference({ ...f.target, expectedRevision: 1 }), { ok: false, error: 'conflict' });
  assert.deepEqual(await f.store.saveTranscript({ ...f.target, bindingRevision: 0, expectedRevision: 2, referenceTranscript: 'stale' }), { ok: false, error: 'unbound' });
  const selected = await f.store.selectReference({ ...f.target, expectedRevision: 2 }, f.path); assert.ok(selected.ok);
  assert.equal(selected.profile.revision, 3); assert.equal(selected.profile.referenceTranscript, ''); assert.equal(selected.profile.ready, false);
  const cleared = await f.store.clearReference({ ...f.target, expectedRevision: 3 }); assert.ok(cleared.ok);
  assert.equal(cleared.profile.revision, 4); assert.equal(cleared.profile.hasReference, false);
  assert.equal((await readdir(join(f.liveRoot, 'voices', f.target.petID))).filter(name => name.endsWith('.wav')).length, 0);
  assert.deepEqual(await f.store.saveTranscript({ ...f.target, expectedRevision: 4, referenceTranscript: '无样本' }), { ok: false, error: 'reference-required' });
});

test('selection rejects cancelled, malformed WAV, traversal, source symlinks and symlink ancestors', async t => {
  const f = await fixture(t), input = { ...f.target, expectedRevision: 0 };
  const cancelled = new AbortController(); cancelled.abort();
  assert.deepEqual(await f.store.selectReference(input, f.path, cancelled.signal), { ok: false, error: 'cancelled' });
  const bad = join(f.root, 'bad.wav'); await writeFile(bad, 'not audio');
  const link = join(f.root, 'link.wav'); await symlink(f.path, link);
  const parent = join(f.root, 'source-link'); await symlink(f.root, parent);
  for (const path of [bad, link, join(parent, 'chosen.wav'), 'relative.wav']) assert.deepEqual(await f.store.selectReference(input, path), { ok: false, error: 'invalid' });
  assert.deepEqual(await f.store.selectReference({ ...input, petID: '../other' }, f.path), { ok: false, error: 'invalid' });
  const state = await f.store.read(f.target); assert.ok(state.ok); assert.equal(state.profile.revision, 0);
});

test('private profile and reference symlinks, corruption and non-private modes fail closed', async t => {
  const f = await fixture(t); await f.ready();
  const directory = join(f.liveRoot, 'voices', f.target.petID), files = await readdir(directory);
  const audio = files.find(name => name.endsWith('.wav'))!;
  await chmod(join(directory, audio), 0o644);
  assert.deepEqual(await f.store.read(f.target), { ok: false, error: 'storage' });
  await chmod(join(directory, audio), 0o600);
  await rm(join(directory, audio)); await symlink(f.path, join(directory, audio));
  assert.deepEqual(await f.store.read(f.target), { ok: false, error: 'storage' });
  await rm(join(directory, audio)); await writeFile(join(directory, audio), wav(7), { mode: 0o600 });
  assert.deepEqual(await f.store.read(f.target), { ok: false, error: 'storage' });
});

test('binding unbind, deletion and mismatched role package cannot read or synthesize saved voices', async t => {
  const f = await fixture(t); await f.ready();
  assert.deepEqual(await f.store.read({ ...f.target, role: 'dafeiyu' }), { ok: false, error: 'unbound' });
  await f.bindings.write(1, { longmei: null, dafeiyu: f.whale.petID });
  assert.deepEqual(await f.store.read(f.target), { ok: false, error: 'unbound' });
  await f.bindings.write(2, { longmei: f.whale.petID, dafeiyu: null });
  assert.deepEqual(await f.store.read({ ...f.target, petID: f.whale.petID, bindingRevision: 3 }), { ok: false, error: 'unbound' });
  await f.bindings.write(3, { longmei: f.target.petID, dafeiyu: f.whale.petID });
  const state = await f.workspace.list(); assert.ok(state.ok);
  const removed = await f.workspace.mutate('delete', { expectedRevision: state.workspace.revision, id: f.target.petID }); assert.ok(removed.ok);
  assert.deepEqual(await f.store.read({ ...f.target, bindingRevision: 4 }), { ok: false, error: 'unbound' });
});

test('failed durable publish fences writes and synthesis until explicit successful reread', async t => {
  const f = await fixture(t); let fail = true;
  const store = new LiveVoiceProfileStore(f.liveRoot, { workspace: f.workspace, bindings: f.bindings, io: { syncDirectory: async () => { if (fail) throw Error('private/path must not escape'); } } });
  t.after(() => store.close());
  assert.deepEqual(await store.selectReference({ ...f.target, expectedRevision: 0 }, f.path), { ok: false, error: 'storage' });
  assert.deepEqual(await store.saveTranscript({ ...f.target, expectedRevision: 1, referenceTranscript: '禁止继续写' }), { ok: false, error: 'storage' });
  const speech = new BubbleSpeech({ run: async () => assert.fail(), close: async () => {}, renderStageReply: async () => { assert.fail('uncertain profile must never synthesize'); } }); t.after(() => speech.close());
  assert.deepEqual(await store.prepareStageVoice({ ...f.target, expectedRevision: 1 }, speech, new AbortController().signal, () => true), { ok: false, error: 'voice-failed' });
  assert.deepEqual(await store.read(f.target), { ok: false, error: 'storage' });
  fail = false;
  assert.deepEqual(await store.readForStage(f.target), { ok: false, error: 'storage' });
  assert.deepEqual(await store.clearReference({ ...f.target, expectedRevision: 1 }), { ok: false, error: 'storage' });
  const reloaded = await store.read(f.target); assert.ok(reloaded.ok); assert.equal(reloaded.profile.revision, 1);
  assert.equal((await store.saveTranscript({ ...f.target, expectedRevision: 1, referenceTranscript: '已重读确认' })).ok, true);
});

test('late cancellation after rename is uncertain and must be reread, not silently reused', async t => {
  const f = await fixture(t), abort = new AbortController();
  const store = new LiveVoiceProfileStore(f.liveRoot, { workspace: f.workspace, bindings: f.bindings, io: { rename: async (from, to) => { await rename(from, to); abort.abort(); } } });
  t.after(() => store.close());
  assert.deepEqual(await store.selectReference({ ...f.target, expectedRevision: 0 }, f.path, abort.signal), { ok: false, error: 'cancelled' });
  assert.deepEqual(await store.clearReference({ ...f.target, expectedRevision: 1 }), { ok: false, error: 'storage' });
  assert.equal((await store.read(f.target)).ok, true);
});

test('stage synthesis is instance-explicit and rechecks binding and profile after rendering', async t => {
  const f = await fixture(t); await f.ready();
  let calls = 0, release!: () => void, started!: () => void;
  let gate = new Promise<void>(resolve => { release = resolve; });
  let began = new Promise<void>(resolve => { started = resolve; });
  const speech = new BubbleSpeech({ run: async () => assert.fail('no device playback'), close: async () => {}, renderStageReply: async (profile, _text, signal) => {
    calls++; assert.equal(profile.transcript, '用户明确选择的测试音色'); started(); await gate; signal.throwIfAborted(); return wav();
  } }); t.after(() => speech.close());
  assert.deepEqual(await f.store.prepareStageVoice({ ...f.whale, expectedRevision: 0 }, speech, new AbortController().signal, () => true), { ok: false, error: 'reference-required' }); assert.equal(calls, 0);
  const pending = f.store.prepareStageVoice({ ...f.target, expectedRevision: 2 }, speech, new AbortController().signal, () => true);
  await began; await f.bindings.write(1, { longmei: null, dafeiyu: f.whale.petID }); release();
  assert.deepEqual(await pending, { ok: false, error: 'voice-failed' });
  await f.bindings.write(2, { longmei: f.target.petID, dafeiyu: f.whale.petID });
  gate = new Promise(resolve => { release = resolve; }); began = new Promise(resolve => { started = resolve; });
  const input = { ...f.target, bindingRevision: 3, expectedRevision: 2 };
  const reply = f.store.prepareStageReply(input, speech, '你好，很高兴见到你！', new AbortController().signal, () => true);
  await began; const clearing = f.store.clearReference(input); release(); assert.equal((await clearing).ok, true); assert.equal(await reply, undefined);
});

test('voice profile routes expose path-free state, enforce exact bodies and never consult desktop speech', async t => {
  const f = await fixture(t), app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  registerLiveVoiceProfileRoutes(app, f.store); t.after(() => app.close());
  const post = (route: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: `/v1/live/voice-profile/${route}`, payload });
  let response = await post('read', f.target); assert.ok(isLiveVoiceProfileResult(response.json())); assert.equal(response.json().profile.ready, false);
  assert.equal((await post('read', { ...f.target, path: f.path })).statusCode, 400);
  assert.equal((await post('select-reference', { ...f.target, expectedRevision: 0 })).statusCode, 400);
  response = await post('select-reference', { ...f.target, expectedRevision: 0, path: f.path }); assert.equal(response.statusCode, 200);
  assert.equal(JSON.stringify(response.json()).includes(f.root), false);
  response = await post('transcript', { ...f.target, expectedRevision: 1, referenceTranscript: '显式直播音色' }); assert.equal(response.json().profile.ready, true);
  response = await post('clear-reference', { ...f.target, expectedRevision: 0 }); assert.equal(response.statusCode, 409);
  response = await post('clear-reference', { ...f.target, expectedRevision: 2 }); assert.equal(response.json().profile.hasReference, false);
  assert.equal((await post('read?path=/private', f.target)).statusCode, 400);
});

test('a revoked first stage line blocks the remaining lines and the entire bank', async t => {
  const f = await fixture(t); await f.ready();
  let calls = 0;
  const speech = new BubbleSpeech({ run: async () => assert.fail(), close: async () => {}, renderStageReply: async () => {
    if (++calls === 1) await f.bindings.write(1, { longmei: null, dafeiyu: f.whale.petID });
    return wav();
  } }); t.after(() => speech.close());
  assert.deepEqual(await f.store.prepareStageVoice({ ...f.target, expectedRevision: 2 }, speech, new AbortController().signal, () => true), { ok: false, error: 'voice-failed' });
  assert.equal(calls, 1);
});

test('reread after an ambiguous replacement reconciles superseded owned references', async t => {
  const f = await fixture(t); await f.ready();
  let fail = true;
  const store = new LiveVoiceProfileStore(f.liveRoot, { workspace: f.workspace, bindings: f.bindings, io: { syncDirectory: async () => { if (fail) throw Error('sync failed'); } } });
  t.after(() => store.close());
  const replacement = join(f.root, 'replacement.wav'); await writeFile(replacement, wav(1));
  assert.deepEqual(await store.selectReference({ ...f.target, expectedRevision: 2 }, replacement), { ok: false, error: 'storage' });
  fail = false;
  const checked = await store.read(f.target); assert.ok(checked.ok); assert.equal(checked.profile.revision, 3);
  const directory = join(f.liveRoot, 'voices', f.target.petID), files = (await readdir(directory)).filter(name => name.endsWith('.wav'));
  assert.equal(files.length, 1); assert.deepEqual(await readFile(join(directory, files[0]!)), wav(1));
});

test('binding revocation and voice commit share the workspace-to-shares management gate', async t => {
  const f = await fixture(t);
  const { LiveShareStore } = await import('../src/live/sharing.ts');
  const { registerLiveRoleBindings } = await import('../src/live/role-binding-routes.ts');
  const shares = new LiveShareStore(f.liveRoot), app = Fastify();
  registerLiveRoleBindings(app, f.bindings, f.workspace, shares);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const store = new LiveVoiceProfileStore(f.liveRoot, { workspace: f.workspace, bindings: f.bindings, shares, io: { rename: async (from, to) => { entered(); await gate; await rename(from, to); } } });
  t.after(async () => { release(); await store.close(); await shares.close(); await app.close(); });
  const writing = store.selectReference({ ...f.target, expectedRevision: 0 }, f.path);
  await started;
  const unbinding = app.inject({ method: 'POST', url: '/v1/live/role-bindings', payload: { role: 'longmei', petID: null, expectedRevision: 1 } });
  // Queue a witness through the same gate, independent of request timing.
  const witness = shares.manage(async () => {});
  const observed = await Promise.race([witness.then(() => 'bypassed'), new Promise(resolve => setTimeout(() => resolve('blocked'), 120))]);
  release();
  assert.equal(observed, 'blocked');
  assert.equal((await writing).ok, true);
  await witness; assert.equal((await unbinding).statusCode, 200);
  assert.deepEqual(await store.read(f.target), { ok: false, error: 'unbound' });
});


test('global pause drains speech even when its next live voice recheck is queued behind workspace pause', async t => {
  let enterPause!: () => void, queued!: () => void, escape!: () => void;
  const pauseEntered = new Promise<void>(resolve => { enterPause = resolve; });
  const captureQueued = new Promise<void>(resolve => { queued = resolve; });
  const release = new Promise<void>(resolve => { escape = resolve; });
  let playbackCalls = 0;
  const speech = new BubbleSpeech({ run: async () => assert.fail(), close: async () => {},
    renderStageReply: async () => { playbackCalls++; await pauseEntered; return wav(); } });
  const f = await fixture(t, async () => {
    enterPause();
    await captureQueued;
    return Promise.race([speech.pause().then(() => true), release.then(() => false)]);
  });
  await f.ready();
  let captures = 0;
  const store = new LiveVoiceProfileStore(f.liveRoot, { bindings: f.bindings, workspace: {
    withRegisteredInstance(id, operation) {
      if (++captures === 3) queued();
      return f.workspace.withRegisteredInstance(id, operation);
    },
  } });
  t.after(async () => { await store.close(); await speech.close(); });
  const rendering = store.prepareStageVoice({ ...f.target, expectedRevision: 2 }, speech, new AbortController().signal, () => true);
  const firstClip = async () => { while (!playbackCalls) await new Promise(resolve => setImmediate(resolve)); };
  await firstClip();
  const pause = f.workspace.mutate('pause', { expectedRevision: 3 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    assert.ok(await Promise.race([pause.then(result => result.ok), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 500); })]),
      'pause must not wait on a workspace lookup that is queued behind it');
    assert.deepEqual(await rendering, { ok: false, error: 'voice-failed' });
    assert.equal(playbackCalls, 1);
  } finally { clearTimeout(timer); escape(); await pause; await rendering; }
});
