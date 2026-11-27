import type { LiveVoiceProfileStore } from '../src/live/voice-profiles.ts';
import { CharacterLearning } from '../src/characters/learning.ts';
import { registerCharacterLearningRoutes } from '../src/characters/learning-routes.ts';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import Fastify from 'fastify';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { longmei } from '../../../packages/contracts/src/built-in-pets.ts';
import type { ChatRoute } from '../../../packages/contracts/src/online-chat.ts';
import type { ModelInput } from '../src/models/types.ts';
import { CharacterRepository } from '../src/characters/repository.ts';
import { PetWorkspace } from '../src/pet-workspace.ts';
import { registerLiveSharing } from '../src/live/sharing-routes.ts';
import { registerLiveDanmaku } from '../src/live/danmaku.ts';
import { LiveRoleBindingStore } from '../src/live/role-bindings.ts';
import { LiveShareStore } from '../src/live/sharing.ts';
import type { ModelManagement } from '../src/models/management.ts';
import type { BubbleSpeech } from '../src/speech/bubble-speech.ts';

const identity = {
  name: '龙妹', role: '桌边的陪伴者', background: '来自云端', personality: '热情', values: '真诚',
  motivations: '陪伴用户', relationship: '用户的桌宠', speakingStyle: '轻松活泼', knowledgeScope: '有限常识', boundaries: '不泄露私人资料',
};
const route: ChatRoute = { connectionID: 'provider', modelEntryID: 'model', fingerprint: 'a'.repeat(64) };
const authorizedIdentity = { petID: '', recordID: 'identity', recordRevision: 1, kind: 'identity' } as const;

async function fixture(t: TestContext, prepareStageReply?: BubbleSpeech['prepareStageReply']) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'live-danmaku-'));
  const workspace = new PetWorkspace({ root: join(root, 'workspace'), catalog: [{ ...longmei, name: '龙妹' }] });
  const characters = new CharacterRepository(join(root, 'characters'));
  const bindings = new LiveRoleBindingStore(join(root, 'live'));
  const shares = new LiveShareStore(join(root, 'live'));
  const added = await workspace.mutate('add', { expectedRevision: 0, package: longmei });
  assert.ok(added.ok);
  const petID = added.workspace.instances[0]!.id;
  await characters.apply(petID, 0, { type: 'saveIdentity', value: identity });
  await bindings.write(0, { longmei: petID, dafeiyu: null });
  await shares.write(0, [{ ...authorizedIdentity, petID }]);

  const seen: ModelInput[] = [];
  const models = {
    listChatModels: async () => [{ route: { ...route }, isDefault: true }],
    completeChat: async (_route: ChatRoute, prepare: (dispatch: (input: ModelInput) => void, signal: AbortSignal) => Promise<void>, signal: AbortSignal) => {
      let input: ModelInput | undefined;
      await prepare(value => { input = value; }, signal);
      if (signal.aborted) throw new Error('cancelled');
      assert.ok(input);
      seen.push(input);
      return { message: { role: 'assistant' as const, text: '欢迎来到海边直播间！' }, stop: 'end' as const, usage: {} };
    },
    assertChatRoute: async () => undefined,
  } as unknown as ModelManagement;
  const speech = {
    prepareStageReply: prepareStageReply ?? (async () => Buffer.from('wav')),
  } as unknown as BubbleSpeech;
  const app = Fastify({ logger: false });
  const voices = {
    readForStage: async () => ({ok:true,profile:{ready:true,revision:2}}),
    prepareStageReply: async (_input:unknown,_speech:unknown,text:string,signal:AbortSignal,eligible:()=>boolean) => speech.prepareStageReply(text,signal,eligible),
  } as unknown as LiveVoiceProfileStore;
  const learning=new CharacterLearning({models,workspace,characters,bindings,shares});
  registerCharacterLearningRoutes(app,learning);
  const danmaku = registerLiveDanmaku(app, models, speech, () => true, workspace, characters, bindings, shares,voices,learning);
  registerLiveSharing(app,shares,workspace,characters,bindings);
  await app.ready();
  t.after(async () => {
    await danmaku.close();
    learning.close();
    await app.close();
    await Promise.all([workspace.close(), characters.close(), bindings.close(), shares.close()]);
    await rm(root, { recursive: true, force: true });
  });
  const post = (url: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url, payload: url.endsWith('/danmaku/reply') ? {voice:{role:'longmei',petID,bindingRevision:1,expectedRevision:2},...payload} : payload });
  return { app, bindings, characters, models, petID, post, seen, shares };
}

test('live audio rechecks the bound and authorized character after speech synthesis', async t => {
  let shares!: LiveShareStore;
  let revokeOnSynthesis = false;
  const f = await fixture(t, async (_text, _signal, eligible) => {
    assert.equal(eligible(), true);
    if (revokeOnSynthesis) await shares.write(1, []);
    return Buffer.from('wav');
  });
  shares = f.shares;

  const reply = await f.post('/v1/live/danmaku/reply', { role: 'longmei', scene: 'desk-room', text: '欢迎大家' });
  assert.equal(reply.statusCode, 200, reply.body);
  const ticket = reply.json<{ ticket: string }>().ticket;

  revokeOnSynthesis = true;
  const audio = await f.post('/v1/live/danmaku/audio', { ticket });
  assert.equal(audio.headers['x-adpets-learning-ticket'],undefined);
  assert.equal(audio.statusCode, 409, 'a revoked live-share grant must not produce program audio');
});


test('live replies never dispatch revoked identity after model selection or credential preparation', async t => {
  for (const phase of ['model-selection', 'credentials'] as const) await t.test(phase, async t => {
    const f = await fixture(t);
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    if (phase === 'model-selection') {
      const list = f.models.listChatModels.bind(f.models);
      f.models.listChatModels = async () => { entered(); await held; return list(); };
    } else {
      const complete = f.models.completeChat.bind(f.models);
      f.models.completeChat = async (...args) => { entered(); await held; return complete(...args); };
    }
    const pending = f.post('/v1/live/danmaku/reply', { role:'longmei', scene:'desk-room', text:'欢迎大家' }).then(r=>r);
    await reached;
    try {
      const revoked = await f.post('/v1/live/shares', { role:'longmei',petID:f.petID,bindingRevision:1,expectedRevision:1,records:[] });
      assert.equal(revoked.statusCode,200);
    } finally { release(); }
    assert.notEqual((await pending).statusCode,200);
    assert.equal(f.seen.length,0,'no captured private context may leave after acknowledged withdrawal');
  });
});
test('live replies do not publish a ticket if consent changes while the model is generating',async t=>{
  const f=await fixture(t);
  const complete=f.models.completeChat.bind(f.models);
  f.models.completeChat=async(...args)=>{const result=await complete(...args);await f.shares.write(1,[]);return result;};
  const response=await f.post('/v1/live/danmaku/reply',{role:'longmei',scene:'desk-room',text:'欢迎大家'});
  assert.equal(f.seen.length,1);
  assert.notEqual(response.statusCode,200);
  assert.equal(response.body.includes('ticket'),false);
});


test('only a successful audio round exposes a short learning ticket; preview is local and the next round revokes it',async t=>{
  const f=await fixture(t);
  const payload={role:'longmei',scene:'desk-room',text:'请用轻松口吻欢迎。'};
  const reply=await f.post('/v1/live/danmaku/reply',payload);assert.equal(reply.statusCode,200);
  assert.equal(reply.headers['x-adpets-learning-ticket'],undefined);
  const audio=await f.post('/v1/live/danmaku/audio',{ticket:reply.json().ticket});assert.equal(audio.statusCode,200);
  const ticket=audio.headers['x-adpets-learning-ticket'];assert.match(String(ticket),/^[a-f0-9]{48}$/);
  const input={petID:f.petID,ticket};
  const preview=await f.post('/v1/characters/learning/preview',input);assert.equal(preview.statusCode,200);
  assert.equal(preview.json().preview.user,payload.text);assert.equal(preview.json().preview.assistant,reply.json().text);
  assert.equal(f.seen.length,1,'preview must not make a provider call');
  await f.post('/v1/live/danmaku/reply',payload);
  assert.notEqual((await f.post('/v1/characters/learning/preview',input)).statusCode,200);
});
