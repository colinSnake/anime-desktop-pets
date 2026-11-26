import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CharacterRepository } from '../../app-service/src/characters/repository.ts';
import { ModelManagement } from '../../app-service/src/models/management.ts';
import { PetWorkspace } from '../../app-service/src/pet-workspace.ts';
import { createService } from '../../app-service/src/server.ts';
import { configuration } from '../../app-service/test/fixtures/models.ts';
import { syntheticVault } from '../../app-service/test/fixtures/secure-models.ts';
import { isRecordSnapshot, recordRoutes, type GoalDraft, type MemoryDraft, type RecordAction, type RecordInputs } from '../../../packages/contracts/src/character-records.ts';
import type { LocalChatIntent } from '../../../packages/contracts/src/local-chat.ts';
import type { ChatRoute } from '../../../packages/contracts/src/online-chat.ts';
import { requestCharacterRecords, requestLocalChatContext, writeIdentity } from '../src/character-transport.ts';
import { requestChatModels, requestOnlineChat } from '../src/chat-transport.ts';
import { requestModelManagement } from '../src/model-transport.ts';
import { requestPets } from '../src/pet-transport.ts';

const pkg = { id: 'local.pet', version: '1.0.0' };
const snapshot = () => ({ kind: 'diagnostic', status: 'idle', detail: '' } as const);
const marker = '合成星图';
const identity = { name: '合成导航员', role: '合成制图助手', background: '', personality: '', values: '', motivations: '', relationship: '', speakingStyle: '', knowledgeScope: '', boundaries: '' };
const memory: MemoryDraft = { kind: '偏好', text: `${marker}用青色标注`, source: '', citation: '', version: '' };
const goal: GoalDraft = { title: `${marker}整理`, details: '保留在本机的目标备注', status: '进行中', steps: [{ text: '准备底稿', isComplete: false }, { text: '核对坐标', isComplete: false }] };
const providers = ['first', 'second'] as const;
const endpoint = (name: typeof providers[number]) => `https://${name}.invalid/v1`;
const fixtureKey = (name: typeof providers[number]) => `SYNTHETIC-ACCEPTANCE-${name}`;

test('workspace acceptance: records survive service restart and chat uses only the selected route and current sharing', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pet-workspace-acceptance-'));
  const { backend } = syntheticVault();
  const sent: { url: string; authorization: string | null; body: string }[] = [];
  const provider: typeof fetch = async (url, init) => {
    sent.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization'), body: String(init?.body) });
    return Response.json({ choices: [{ message: { role: 'assistant', content: '合成模型回应' }, finish_reason: 'stop' }] });
  };
  let app: ReturnType<typeof createService> | undefined;
  t.after(async () => { try { await app?.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  const start = async () => {
    const token = randomBytes(32).toString('hex');
    app = createService({ token, runtime: { snapshot, probe: async () => snapshot(), close: async () => {} },
      workspace: new PetWorkspace({ root, catalog: [{ ...pkg, name: '合成桌宠' }] }),
      characters: new CharacterRepository(join(root, 'characters')),
      chatRuntime: (text, complete) => complete(text), // Synthetic text Runtime; no external model.
      models: new ModelManagement(join(root, 'models'), backend, undefined, { fetch: provider }) });
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    return { base, port: Number(new URL(base).port), token };
  };
  let session = await start();
  const addPet = async (expectedRevision: number) => {
    const added = await requestPets(session, 'add', { expectedRevision, package: pkg });
    assert.ok(added.ok, JSON.stringify(added));
    return added.workspace.instances.at(-1)!.id;
  };
  const petID = await addPet(0);
  const other = await addPet(1);
  assert.notEqual(petID, other);
  const records = async <A extends Exclude<RecordAction, 'readMemoryHistory'>>(action: A, input: RecordInputs[A]) => {
    const result = await requestCharacterRecords(session, action, input);
    assert.ok(result.ok, JSON.stringify(result));
    if ('durability' in result) assert.equal(result.durability, 'confirmed');
    const family = recordRoutes[action].family;
    assert.ok(isRecordSnapshot(family, result.snapshot, input.petID));
    return result.snapshot;
  };
  const local = async (intent: LocalChatIntent, id = petID) => {
    const result = await requestLocalChatContext(session, { ...intent, petID: id });
    assert.ok(result.ok, JSON.stringify(result));
    return result.text;
  };
  const chat = async (route: ChatRoute, id = petID, text = `聊聊${marker}`) => {
    const input = { requestID: randomUUID(), petID: id, route, text, history: [] };
    return requestOnlineChat(session, input, new AbortController().signal);
  };

  const saved = await writeIdentity(session, 'saveIdentity', { petID, expectedRevision: 0, draft: identity });
  assert.ok(saved.ok, JSON.stringify(saved));
  assert.equal(saved.durability, 'confirmed');
  const pending = await records('addMemory', { petID, expectedRevision: saved.snapshot.revision, draft: memory });
  const memoryID = pending.records[0]!.id;
  assert.doesNotMatch(await local({ intent: 'memory', query: marker }), /青色标注/);
  const reviewed = await records('confirmMemory', { petID, expectedRevision: pending.revision, id: memoryID });
  const planned = await records('addGoal', { petID, expectedRevision: reviewed.revision, draft: goal });
  const persistedGoal = planned.records[0]!;
  assert.ok('steps' in persistedGoal);
  const goalID = persistedGoal.id;
  const steps = persistedGoal.steps.map((step, i) => ({ ...step, isComplete: i === 0 }));
  const progress = await records('editGoal', { petID, expectedRevision: planned.revision, id: goalID, draft: { ...goal, steps } });
  const editedGoal = progress.records[0]!;
  assert.ok('steps' in editedGoal);
  assert.deepEqual(editedGoal.steps, steps);

  for (const id of providers) {
    const { credentialRef: _, revision: _revision, ...draft } = configuration().connections[0]!;
    const result = await requestModelManagement(session, 'save', { expectedRevision: 0,
      connection: { ...draft, id, displayName: `合成连接 ${id}`, baseURL: endpoint(id) },
      credential: { kind: 'replace', key: fixtureKey(id) } });
    assert.ok(result.ok, JSON.stringify(result));
  }
  const legacyDefault = await requestModelManagement(session, 'default', { expectedRevision: 2, connectionID: 'second', entryID: 'entry-one' });
  assert.ok(legacyDefault.ok, JSON.stringify(legacyDefault));
  assert.equal(sent.length, 0, 'local writes and queries never send a model request');
  await app!.close();
  session = await start();

  assert.match(await local({ intent: 'identity' }), /合成导航员/);
  assert.match(await local({ intent: 'memory', query: marker }), /青色标注/);
  assert.match(await local({ intent: 'goals' }), /合成星图整理.*1\/2/s);
  assert.doesNotMatch(await local({ intent: 'goals' }, other), /合成星图/);
  assert.doesNotMatch(await local({ intent: 'memory', query: marker }, other), /青色标注/);
  const list = await requestChatModels(session);
  assert.ok(list.ok, JSON.stringify(list));
  assert.doesNotMatch(JSON.stringify(list), /\.invalid|credentialRef|SYNTHETIC/);
  const first = list.models.find(item => item.route.connectionID === 'first');
  const second = list.models.find(item => item.route.connectionID === 'second');
  assert.equal(list.models.length, 2);
  assert.ok(first?.ready && first.isDefault);
  assert.ok(second?.ready && !second.isDefault);
  assert.equal(first.route.modelEntryID, 'entry-one');
  assert.equal(second.route.modelEntryID, 'entry-one');
  assert.equal(sent.length, 0);

  const plain = await chat({ ...first.route, useDefault: true });
  assert.ok(plain.ok && plain.replayable, JSON.stringify(plain));
  assert.equal(sent.at(-1)?.url, `${endpoint('first')}/chat/completions`);
  assert.equal(sent.at(-1)?.authorization, `Bearer ${fixtureKey('first')}`);
  assert.doesNotMatch(sent.at(-1)!.body, /characterContext|青色标注|合成导航员|准备底稿/);
  const sharedMemory = await records('setMemoryChatShare', { petID, expectedRevision: progress.revision, id: memoryID, enabled: true });
  const shared = await records('setGoalChatShare', { petID, expectedRevision: sharedMemory.revision, id: goalID, enabled: true });
  const contextual = await chat(second.route);
  assert.ok(contextual.ok && !contextual.replayable, JSON.stringify(contextual));
  assert.equal(sent.at(-1)?.url, `${endpoint('second')}/chat/completions`);
  assert.equal(sent.at(-1)?.authorization, `Bearer ${fixtureKey('second')}`);
  assert.match(sent.at(-1)!.body, /青色标注/);
  assert.match(sent.at(-1)!.body, /合成星图整理/);
  assert.doesNotMatch(sent.at(-1)!.body, /合成导航员|保留在本机的目标备注|准备底稿/);

  const isolated = await chat(second.route, other);
  assert.ok(isolated.ok && isolated.replayable, JSON.stringify(isolated));
  assert.doesNotMatch(sent.at(-1)!.body, /characterContext|青色标注|合成星图整理/);

  const beforeRejected = sent.length;
  assert.deepEqual(await chat({ ...second.route, useDefault: true }), { ok: false, error: 'route_changed' });
  assert.deepEqual(await chat(second.route, petID, '查看目标进度'), { ok: false, error: 'invalid_request' });
  assert.equal(sent.length, beforeRejected);
  assert.deepEqual(await requestCharacterRecords(session, 'deleteGoal', { petID, expectedRevision: progress.revision, id: goalID }),
    { ok: false, error: 'conflict' });
  const changed = await records('editMemory', { petID, expectedRevision: shared.revision, id: memoryID, draft: { ...memory, text: `${marker}改用橙色标注` } });
  const withoutGoal = await records('deleteGoal', { petID, expectedRevision: changed.revision, id: goalID });
  assert.doesNotMatch(await local({ intent: 'goals' }), /合成星图整理/);
  assert.doesNotMatch(await local({ intent: 'memory', query: marker }), /(?:青|橙)色标注/);
  const sanitized = await chat(second.route);
  assert.ok(sanitized.ok && sanitized.replayable, JSON.stringify(sanitized));
  assert.doesNotMatch(sent.at(-1)!.body, /characterContext|色标注|合成星图整理/);
  await records('deleteMemory', { petID, expectedRevision: withoutGoal.revision, id: memoryID });
  assert.deepEqual(await requestCharacterRecords(session, 'readMemoryHistory', { petID, id: memoryID }), { ok: false, error: 'record-not-found' });
  assert.equal(sent.length, 4);
});
