import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CharacterRepository } from '../src/characters/repository.ts';
import { PetWorkspace } from '../src/pet-workspace.ts';
import { createService } from '../src/server.ts';

const pkg = { id: 'local.pet', version: '1.0.0' };
const identity = { name: '合成角色', role: '', background: '', personality: '', values: '', motivations: '', relationship: '', speakingStyle: '', knowledgeScope: '', boundaries: '' };

test('identity route binds reads to registered instances and exposes only the identity projection', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pet-character-route-'));
  const workspace = new PetWorkspace({ root, catalog: [{ ...pkg, name: '合成桌宠' }] });
  const repository = new CharacterRepository(join(root, 'characters'));
  const snapshot = () => ({ kind: 'diagnostic', status: 'idle', detail: '' } as const);
  const token = 'c'.repeat(64);
  const app = createService({ token, workspace, characters: repository, runtime: { snapshot, probe: async () => snapshot(), close: async () => {} } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const authenticated = { host: '127.0.0.1', authorization: `Bearer ${token}` };
  const read = (id: string) => app.inject({ url: `/v1/characters/${id}/identity`, headers: authenticated });
  const created = await workspace.mutate('add', { expectedRevision: 0, package: pkg });
  assert.ok(created.ok);
  const id = created.workspace.instances[0]!.id;
  assert.equal((await app.inject({ url: `/v1/characters/${id}/identity`, headers: { host: '127.0.0.1' } })).statusCode, 401);
  assert.deepEqual((await read(id)).json(), { schemaVersion: 1, petID: id, revision: 0, identity: null, identityHistory: [] });
  assert.equal((await app.inject({ url: `/v1/characters/${id}/identity?path=/private`, headers: authenticated })).statusCode, 400);
  assert.equal((await read('outside%2Froot')).statusCode, 400);
  await repository.apply(id, 0, { type: 'saveIdentity', value: identity });
  await repository.apply(id, 1, { type: 'addMemory', value: { kind: '事实', text: '不能从身份端点读到的合成记录', source: '', citation: '', version: '' } });
  await repository.apply('private-unregistered', 0, { type: 'saveIdentity', value: identity });
  const filled = await read(id);
  assert.equal(filled.statusCode, 200);
  assert.deepEqual(Object.keys(filled.json()).sort(), ['identity', 'identityHistory', 'petID', 'revision', 'schemaVersion']);
  assert.equal(filled.json().identity.name, identity.name);
  assert.equal(filled.body.includes('合成记录'), false);
  assert.equal((await read('private-unregistered')).statusCode, 404);
  // The later read queues behind the deletion and must not return a snapshot.
  const deletion = workspace.mutate('delete', { expectedRevision: 1, id });
  assert.equal((await read(id)).statusCode, 404);
  assert.ok((await deletion).ok);
  const recreated = await workspace.mutate('add', { expectedRevision: 2, package: pkg });
  assert.ok(recreated.ok);
  const freshId = recreated.workspace.instances[0]!.id;
  await writeFile(join(root, 'characters', `${freshId}.json`), '{"schemaVersion":99}', { mode: 0o600 });
  const corrupt = await read(freshId);
  assert.equal(corrupt.statusCode, 503);
  assert.deepEqual(corrupt.json(), { error: 'character_unavailable' });
});

test('identity writes require current revision and restore history as a new version', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pet-character-write-'));
  const workspace = new PetWorkspace({ root, catalog: [{ ...pkg, name: '合成桌宠' }] });
  let failSync = false;
  const repository = new CharacterRepository(join(root, 'characters'), { io: { syncDirectory: async () => { if (failSync) throw Error('/private/synthetic'); } } });
  const snapshot = () => ({ kind: 'diagnostic', status: 'idle', detail: '' } as const);
  const token = 'd'.repeat(64);
  const app = createService({ token, workspace, characters: repository, runtime: { snapshot, probe: async () => snapshot(), close: async () => {} } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const headers = { host: '127.0.0.1', authorization: `Bearer ${token}` };
  const added = await workspace.mutate('add', { expectedRevision: 0, package: pkg });
  assert.ok(added.ok);
  const id = added.workspace.instances[0]!.id;
  const url = `/v1/characters/${id}/identity`;
  const request = (action: string, payload: object) => app.inject({ method: 'POST', url: `${url}/${action}`, headers, payload });
  const save = (expectedRevision: number, name = identity.name) => request('save', { expectedRevision, draft: { ...identity, name } });
  assert.equal((await app.inject({ method: 'POST', url: `${url}/save`, headers: { host: '127.0.0.1' }, payload: { expectedRevision: 0, draft: identity } })).statusCode, 401);
  assert.equal((await request('save', { expectedRevision: 0, draft: { ...identity, shareWithOnlineModel: true } })).statusCode, 400);
  assert.equal((await request('save', { expectedRevision: 0, draft: identity, petID: 'other-pet' })).statusCode, 400);
  const one = await save(0);
  assert.equal(one.statusCode, 200);
  assert.equal(one.json().durability, 'confirmed');
  assert.equal(one.json().snapshot.identity.name, identity.name);
  assert.equal((await save(1)).json().durability, 'unchanged');
  const two = await save(1, '第二版');
  assert.equal(two.json().snapshot.revision, 2);
  assert.deepEqual((await save(1, '过期草稿')).json(), { ok: false, error: 'conflict' });
  assert.deepEqual((await request('restore', { expectedRevision: 2, historicalRevision: 99 })).json(), { ok: false, error: 'history-not-found' });
  const restored = (await request('restore', { expectedRevision: 2, historicalRevision: 1 })).json();
  assert.equal(restored.snapshot.revision, 3);
  assert.equal(restored.snapshot.identity.name, identity.name);
  assert.deepEqual(restored.snapshot.identityHistory.map((item: { name: string }) => item.name), [identity.name, '第二版']);
  failSync = true;
  const unconfirmed = await save(3, '已发布尚未确认');
  assert.equal(unconfirmed.json().durability, 'unconfirmed');
  assert.equal((await app.inject({ url, headers })).json().revision, 4);
  const deletion = workspace.mutate('delete', { expectedRevision: 1, id });
  assert.equal((await save(4, '不应写入')).statusCode, 404);
  assert.ok((await deletion).ok);
  assert.equal((await repository.read(id)).identity?.name, '已发布尚未确认');
});

async function setupRecordRoutes(t: import('node:test').TestContext, clock = '2026-11-18T12:00:00.000Z') {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pet-character-records-'));
  const workspace = new PetWorkspace({ root, catalog: [{ ...pkg, name: '合成桌宠' }] });
  let failSync = false;
  const repository = new CharacterRepository(join(root, 'characters'), {
    clock: () => new Date(clock),
    io: { syncDirectory: async () => { if (failSync) throw Error('/private/synthetic'); } },
  });
  const snapshot = () => ({ kind: 'diagnostic', status: 'idle', detail: '' } as const);
  const token = 'c'.repeat(64);
  const app = createService({ token, workspace, characters: repository, runtime: { snapshot, probe: async () => snapshot(), close: async () => {} } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const headers = { host: '127.0.0.1', authorization: `Bearer ${token}` };
  const one = await workspace.mutate('add', { expectedRevision: 0, package: pkg });
  const two = await workspace.mutate('add', { expectedRevision: 1, package: pkg });
  assert.ok(one.ok && two.ok);
  const id = one.workspace.instances[0]!.id, other = two.workspace.instances.find(pet => pet.id !== id)!.id;
  const request = (path: string, payload?: object, petID = id) => app.inject({ url: `/v1/characters/${petID}/${path}`, headers, method: payload ? 'POST' : 'GET', payload });
  return { app, workspace, repository, id, other, request, failSync: () => { failSync = true; } };
}

test('local memory bridge isolates projections and supports explicit candidate review', { skip: process.platform === 'win32' }, async t => {
  const { app, workspace, repository, id, other, request, failSync } = await setupRecordRoutes(t);
  await repository.apply(id, 0, { type: 'saveIdentity', value: identity });
  const note = { kind: '知识', text: '合成知识一', source: '合成设定手册', citation: '第一节', version: '1' };
  const add = (expectedRevision: number, changes: object = {}) => request('memories/add', { expectedRevision, draft: { ...note, ...changes } });
  const confirm = (expectedRevision: number, memoryID: string) => request('memories/confirm', { expectedRevision, id: memoryID });
  assert.equal((await app.inject({ url: `/v1/characters/${id}/memories`, headers: { host: '127.0.0.1' } })).statusCode, 401);
  const initial = await request('memories');
  assert.equal(initial.statusCode, 200);
  assert.deepEqual(initial.json(), { schemaVersion: 1, petID: id, revision: 1, records: [] });
  assert.equal((await add(1, { shareWithOnlineModel: true })).statusCode, 400);
  assert.equal((await add(1, { source: '' })).statusCode, 400);
  assert.deepEqual((await add(1, { text: '这是测试密码' })).json(), { ok: false, error: 'credential-like' });
  const first = (await add(1)).json();
  assert.equal(first.durability, 'confirmed');
  const memoryID = first.snapshot.records[0].id;
  assert.equal(first.snapshot.records[0].status, 'candidate');
  assert.deepEqual((await request('memories', undefined, other)).json().records, []);
  assert.equal((await request('memories/confirm', { expectedRevision: 0, id: memoryID }, other)).statusCode, 404);
  assert.deepEqual((await confirm(1, memoryID)).json(), { ok: false, error: 'conflict' });
  assert.equal((await confirm(2, memoryID)).json().snapshot.records[0].status, 'confirmed');
  const conflict = (await add(3, { text: '合成知识二' })).json().snapshot.records[1].id;
  assert.deepEqual((await confirm(4, conflict)).json(), { ok: false, error: 'knowledge-conflict' });
  const duplicate = (await add(4)).json().snapshot.records[2].id;
  assert.deepEqual((await confirm(5, duplicate)).json(), { ok: false, error: 'duplicate' });
  const expired = (await add(5, { text: '合成过期资料', expiresAt: '2026-11-17T00:00:00.000Z' })).json().snapshot.records[3].id;
  assert.deepEqual((await confirm(6, expired)).json(), { ok: false, error: 'expired' });
  failSync();
  const withdrawn = (await request('memories/withdraw', { expectedRevision: 6, id: memoryID })).json();
  assert.equal(withdrawn.durability, 'unconfirmed');
  assert.equal((await request('memories')).json().records[0].status, 'candidate');
  const deletion = workspace.mutate('delete', { expectedRevision: 2, id });
  assert.equal((await confirm(7, memoryID)).statusCode, 404);
  assert.ok((await deletion).ok);
});

test('goal plans save only manual progress and preserve the IDs of existing steps', { skip: process.platform === 'win32' }, async t => {
  const { id, other, request } = await setupRecordRoutes(t);
  const draft = { title: '合成计划', details: '说明', status: '进行中', steps: [{ text: '第一步', isComplete: false }] };
  const add = (revision: number, value = draft, petID = id) => request('goals/add', { expectedRevision: revision, draft: value }, petID);
  const edit = (expectedRevision: number, goalID: string, value = draft, petID = id) => request('goals/edit', { expectedRevision, id: goalID, draft: value }, petID);
  const empty = await request('goals');
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json(), { schemaVersion: 1, petID: id, revision: 0, records: [] });
  assert.equal((await add(0, { ...draft, ...{ runNow: true } })).statusCode, 400);
  const before = (await add(0)).json().snapshot.records[0];
  const otherGoal = (await add(0, draft, other)).json().snapshot.records[0];
  assert.deepEqual((await edit(1, before.id, draft, other)).json(), { ok: false, error: 'record-not-found' });
  assert.equal((await edit(1, before.id, { ...draft, steps: [{ ...draft.steps[0]!, ...{ id: otherGoal.steps[0].id } }] })).statusCode, 400);
  const updated = { ...draft, status: '已暂停', steps: [{ id: before.steps[0].id, text: '已整理', isComplete: true }, { text: '第二步', isComplete: false }] };
  assert.deepEqual((await edit(0, before.id, updated)).json(), { ok: false, error: 'conflict' });
  const after = (await edit(1, before.id, updated)).json().snapshot.records[0];
  assert.equal(after.id, before.id);
  assert.equal(after.steps[0].id, before.steps[0].id);
  assert.equal(after.steps[0].isComplete, true);
  assert.notEqual(after.steps[1].id, after.steps[0].id);
  assert.equal(after.status, '已暂停');
  assert.deepEqual((await request('goals')).json().records, [after]);
  assert.deepEqual((await request('goals', undefined, other)).json().records, [otherGoal]);
  assert.deepEqual((await request('memories')).json().records, []);
});

test('memory edits and bounded history restore stay within the registered instance and require fresh review', { skip: process.platform === 'win32' }, async t => {
  const { app, workspace, id, other, request } = await setupRecordRoutes(t);
  const draft = { kind: '知识', text: '第一版合成知识', source: '合成设定', citation: '第一节', version: '1' };
  const first = (await request('memories/add', { expectedRevision: 0, draft })).json();
  const memoryID = first.snapshot.records[0].id;
  const historyPath = `memories/history/${memoryID}`;
  const history = () => request(historyPath);
  const edit = (expectedRevision: number, replacement: object) => request('memories/edit', { expectedRevision, id: memoryID, draft: replacement });
  const restore = (expectedRevision: number, historicalRevision: number, extra = {}) => request('memories/restore', { expectedRevision, id: memoryID, historicalRevision, ...extra });
  assert.equal((await app.inject({ url: `/v1/characters/${id}/${historyPath}`, headers: { host: '127.0.0.1' } })).statusCode, 401);
  assert.equal((await history()).statusCode, 200);
  assert.deepEqual((await history()).json(), { schemaVersion: 1, petID: id, id: memoryID, revision: 1, currentRevision: 1, history: [] });
  assert.equal((await request('memories/history/invalid')).statusCode, 400);
  assert.equal((await request(`${historyPath}?all=true`)).statusCode, 400);
  assert.deepEqual((await request(historyPath, undefined, other)).json(), { ok: false, error: 'record-not-found' });
  const confirmed = (await request('memories/confirm', { expectedRevision: 1, id: memoryID })).json().snapshot.records[0];
  const equal = (await edit(2, draft)).json();
  assert.equal(equal.durability, 'unchanged');
  assert.deepEqual(equal.snapshot.records, [confirmed]);
  assert.deepEqual((await history()).json().history, []);
  assert.deepEqual((await edit(1, draft)).json(), { ok: false, error: 'conflict' });
  assert.deepEqual((await edit(2, { ...draft, text: '测试密钥' })).json(), { ok: false, error: 'credential-like' });
  assert.equal((await edit(2, { ...draft, status: 'confirmed' })).statusCode, 400);
  assert.equal((await restore(2, 0)).statusCode, 400);
  assert.equal((await restore(2, 1, { id: 'other' })).statusCode, 400);
  const changed = (await edit(2, { ...draft, text: '第二版合成知识' })).json().snapshot.records[0];
  assert.equal(changed.revision, 2);
  assert.equal(changed.status, 'candidate');
  assert.equal(changed.confirmedAt, undefined);
  assert.deepEqual((await history()).json().history, [confirmed]);
  assert.equal((await request('memories')).json().history, undefined);
  assert.equal((await restore(2, 1)).statusCode, 409);
  assert.equal((await restore(3, 2)).statusCode, 404);
  const restored = (await restore(3, 1)).json().snapshot.records[0];
  assert.equal(restored.id, memoryID);
  assert.equal(restored.text, draft.text);
  assert.equal(restored.revision, 3);
  assert.equal(restored.status, 'candidate');
  assert.equal(restored.confirmedAt, undefined);
  for (let revision = 4; revision < 9; revision++) assert.equal((await edit(revision, { ...draft, text: `合成修订 ${revision}` })).statusCode, 200);
  assert.deepEqual((await history()).json().history.map((item: { revision: number }) => item.revision), [3, 4, 5, 6, 7]);
  assert.equal((await restore(9, 1)).statusCode, 404);
  assert.ok((await workspace.mutate('delete', { expectedRevision: 2, id })).ok);
  assert.deepEqual((await history()).json(), { ok: false, error: 'not-found' });
  assert.equal((await edit(9, draft)).statusCode, 404);
  assert.equal((await restore(9, 7)).statusCode, 404);
});

test('knowledge import commits one atomic candidate batch within the selected instance and revision', { skip: process.platform === 'win32' }, async t => {
  const { workspace, id, other, request, failSync } = await setupRecordRoutes(t);
  const note = { kind: '知识', text: '合成设定甲', source: '合成手册', citation: '第 1 节', version: '初版' };
  const second = { ...note, text: '合成设定乙', citation: '第 2 节' };
  const batch = (expectedRevision: number, drafts: object[], petID = id) => request('memories/import', { expectedRevision, drafts }, petID);
  for (const [drafts, error, code] of [
    [[], 'invalid', 400], [[{ ...note, source: '' }], 'invalid', 400], [[{ ...note, kind: '事实' }], 'invalid', 400],
    [[{ ...note, confirmed: true }], 'invalid', 400], [[note, { ...second, text: '合成密钥' }], 'credential-like', 422],
    [[note, { ...second, expiresAt: '2026-11-17T00:00:00.000Z' }], 'expired', 422],
    [[note, { ...second, text: '\u3000合成·设定甲！' }], 'duplicate', 422], [[note, { ...second, citation: note.citation }], 'knowledge-conflict', 422],
    [Array.from({ length: 51 }, (_, i) => ({ ...note, text: `合成段 ${i}` })), 'invalid', 400],
  ] satisfies [object[], string, number][]) {
    const response = await batch(0, drafts);
    assert.equal(response.statusCode, code);
    assert.deepEqual(response.json(), { ok: false, error });
  }
  assert.equal((await request('memories')).json().revision, 0);
  assert.equal((await batch(1, [note, second])).statusCode, 409);
  const committed = (await batch(0, [note, second])).json();
  assert.equal(committed.snapshot.revision, 1);
  assert.equal(committed.durability, 'confirmed');
  assert.deepEqual(committed.snapshot.records.map((record: { text: string; status: string }) => [record.text, record.status]), [[note.text, 'candidate'], [second.text, 'candidate']]);
  assert.deepEqual((await batch(1, [note])).json(), { ok: false, error: 'duplicate' });
  assert.deepEqual((await batch(1, [{ ...note, text: '新知识依据撞车' }])).json(), { ok: false, error: 'knowledge-conflict' });
  assert.equal((await request('memories', undefined, other)).json().records.length, 0);
  const filler = (start: number, size: number) => Array.from({ length: size }, (_, i) => ({ ...note, text: `独有知识${start + i}`, citation: '' }));
  assert.equal((await batch(0, filler(0, 50), other)).statusCode, 200);
  assert.equal((await batch(1, filler(50, 13), other)).statusCode, 200);
  assert.deepEqual((await batch(2, filler(63, 2), other)).json(), { ok: false, error: 'limit' });
  assert.equal((await request('memories', undefined, other)).json().records.length, 63);
  assert.ok((await workspace.mutate('delete', { expectedRevision: 2, id: other })).ok);
  assert.equal((await batch(0, [note], other)).statusCode, 404);
  failSync();
  const uncertain = (await batch(1, [{ ...second, text: '第三段', citation: '第 3 节' }])).json();
  assert.equal(uncertain.durability, 'unconfirmed');
  const latest = (await request('memories')).json();
  assert.equal(latest.revision, 2);
  assert.equal(latest.records.length, 3);
});

test('knowledge search is authenticated, scoped to the matching current revision and never changes records', { skip: process.platform === 'win32' }, async t => {
  const { app, id, other, request, workspace } = await setupRecordRoutes(t);
  const payload = { expectedRevision: 0, query: '合成图鉴' };
  const search = (changes: object = {}, petID = id) => request('memories/search', { ...payload, ...changes }, petID);
  assert.equal((await app.inject({ url: `/v1/characters/${id}/memories/search`, method: 'POST', headers: { host: '127.0.0.1' }, payload })).statusCode, 401);
  assert.equal((await search()).statusCode, 200);
  for (const changes of [{ petID: other }, { limit: 300 }, { query: '\t' }, { query: '词'.repeat(121) }, { query: '合成密钥' }]) {
    assert.deepEqual((await search(changes)).json(), { ok: false, error: 'invalid' });
  }
  assert.equal((await request('memories/search?query=私有词', payload)).statusCode, 400);
  assert.equal((await search({ query: 'x'.repeat(2049) })).statusCode, 413);
  const add = async (expectedRevision: number, draft: object, petID = id) => (await request('memories/add', { expectedRevision, draft }, petID)).json().snapshot.records.at(-1).id;
  const confirm = (expectedRevision: number, memoryID: string, petID = id) => request('memories/confirm', { expectedRevision, id: memoryID }, petID);
  const knowledge = { kind: '知识', text: '月面日志', source: '合成图鉴', citation: '', version: '' };
  const confirmed = await add(0, knowledge);
  assert.equal((await confirm(1, confirmed)).statusCode, 200);
  await add(2, { ...knowledge, text: '候选内容' });
  const personal = await add(3, { ...knowledge, kind: '事实', text: '合成图鉴私事' });
  assert.equal((await confirm(4, personal)).statusCode, 200);
  const differentPet = await add(0, { ...knowledge, text: '别的实例的月面日志' }, other);
  assert.equal((await confirm(1, differentPet, other)).statusCode, 200);
  const before = (await request('memories')).json();
  assert.deepEqual((await search()).json(), { ok: false, error: 'conflict' });
  assert.deepEqual((await search({ expectedRevision: 5 })).json(), { ok: true, petID: id, revision: 5, ids: [confirmed] });
  assert.deepEqual((await search({ expectedRevision: 2 }, other)).json(), { ok: true, petID: other, revision: 2, ids: [differentPet] });
  assert.deepEqual((await request('memories')).json(), before);
  await request('memories/withdraw', { expectedRevision: 5, id: confirmed });
  assert.deepEqual((await search({ expectedRevision: 6 })).json(), { ok: true, petID: id, revision: 6, ids: [] });
  assert.ok((await workspace.mutate('delete', { expectedRevision: 2, id: other })).ok);
  assert.deepEqual((await search({ expectedRevision: 2 }, other)).json(), { ok: false, error: 'not-found' });
});

test('explicit record deletion binds the instance and revision, removes history and steps, and reports unconfirmed writes', { skip: process.platform === 'win32' }, async t => {
  const { app, id, other, repository, request, failSync } = await setupRecordRoutes(t);
  const note = { kind: '知识', text: '合成图鉴正文', source: '图鉴', citation: '', version: '' } as const;
  const first = await repository.apply(id, 0, { type: 'addMemory', value: note });
  const memoryID = first.state.memories[0]!.current.id;
  await repository.apply(id, 1, { type: 'editMemory', id: memoryID, value: { ...note, text: '新合成图鉴正文' } });
  const goal = { title: '合成目标', details: '', status: '进行中', steps: [{ text: '完成一页', isComplete: false }] } as const;
  const withGoal = await repository.apply(id, 2, { type: 'addGoal', value: { ...goal, steps: [...goal.steps] } });
  const goalID = withGoal.state.goals[0]!.id;
  await repository.apply(other, 0, { type: 'addMemory', value: note });
  const remove = { expectedRevision: 3, id: memoryID };
  assert.deepEqual((await request('memories/delete', { ...remove, path: '/private' })).json(), { ok: false, error: 'invalid' });
  assert.equal((await app.inject({ url: `/v1/characters/${id}/memories/delete`, method: 'POST', headers: { host: '127.0.0.1' }, payload: remove })).statusCode, 401);
  assert.deepEqual((await request('memories/delete', { ...remove, expectedRevision: 2 })).json(), { ok: false, error: 'conflict' });
  assert.deepEqual((await request('memories/delete', { ...remove, expectedRevision: 1 }, other)).json(), { ok: false, error: 'record-not-found' });
  assert.deepEqual((await request('goals/delete', remove)).json(), { ok: false, error: 'record-not-found' });
  assert.equal((await request(`memories/history/${memoryID}`)).json().history.length, 1);
  assert.deepEqual((await request('memories/delete', remove)).json(), { ok: true, snapshot: { schemaVersion: 1, petID: id, revision: 4, records: [] }, durability: 'confirmed' });
  assert.equal((await request(`memories/history/${memoryID}`)).statusCode, 404);
  assert.equal((await request('memories', undefined, other)).json().records.length, 1);
  assert.equal((await request('goals')).json().records[0].steps.length, 1);
  failSync();
  const deleted = (await request('goals/delete', { expectedRevision: 4, id: goalID })).json();
  assert.equal(deleted.durability, 'unconfirmed');
  assert.deepEqual((await request('goals')).json().records, []);
  assert.deepEqual((await request('goals/delete', { expectedRevision: 4, id: goalID })).json(), { ok: false, error: 'conflict' });
});

test('chat context answers explicit local intents from only the latest registered instance records', { skip: process.platform === 'win32' }, async t => {
  const { app, repository, workspace, request, id, other } = await setupRecordRoutes(t, '2000-01-01T00:00:00.000Z');
  const answer = (intent: string, fields = {}, petID = id) => request('chat/local-context', { intent, ...fields }, petID);
  const knowledge = { kind: '知识', text: '合成星图放在北窗', source: '导航手册', citation: '§3', version: '试读版' } as const;
  await repository.apply(id, 0, { type: 'saveIdentity', value: { ...identity, role: '本机导航向导', background: '不应返回的背景' } });
  const added = await repository.apply(id, 1, { type: 'addMemory', value: knowledge });
  const savedID = added.state.memories[0]!.current.id;
  await repository.apply(id, 2, { type: 'confirmMemory', id: savedID });
  await repository.apply(id, 3, { type: 'addMemory', value: { ...knowledge, text: '合成星图候选', citation: '§4' } });
  const personal = await repository.apply(id, 4, { type: 'addMemory', value: { kind: '偏好', text: '偏好星图用青色', source: '只应返回正文', citation: '', version: '' } });
  await repository.apply(id, 5, { type: 'confirmMemory', id: personal.state.memories[2]!.current.id });
  const expired = await repository.apply(id, 6, { type: 'addMemory', value: { ...knowledge, text: '合成星图过期资料', citation: '§5', expiresAt: '2000-01-02T00:00:00.000Z' } });
  await repository.apply(id, 7, { type: 'confirmMemory', id: expired.state.memories[3]!.current.id });
  await repository.apply(id, 8, { type: 'addGoal', value: { title: '合成目标', status: '进行中', details: '不应该返回的目标说明', steps: [{ text: '完成合成任务', isComplete: true }, { text: '合成密码', isComplete: false }] } });
  assert.equal((await app.inject({ method: 'POST', url: `/v1/characters/${id}/chat/local-context`, headers: { host: '127.0.0.1' }, payload: { intent: 'goals' } })).statusCode, 401);
  for (const query of [{ intent: 'knowledge', query: '合成密码' }, { intent: 'identity', query: '多余参数' }, { intent: 'goals', petID: other }, { intent: 'open-url', url: 'https://synthetic.invalid/' }]) {
    assert.deepEqual((await request('chat/local-context', query)).json(), { ok: false, error: 'invalid' });
  }
  assert.equal((await answer('knowledge', { query: '星图'.repeat(1200) })).statusCode, 413);
  const who = (await answer('identity')).json();
  assert.equal(who.petID, id);
  assert.match(who.text, /合成角色.*本机导航向导/s);
  assert.doesNotMatch(who.text, /背景/);
  const knowledgeReply = (await answer('knowledge', { query: '星图' })).json();
  assert.match(knowledgeReply.text, /合成星图放在北窗.*导航手册.*§3.*试读版/s);
  assert.doesNotMatch(knowledgeReply.text, /候选|偏好|过期资料/);
  assert.match((await answer('memory', { query: '星图' })).json().text, /偏好星图用青色/);
  assert.match((await answer('goals')).json().text, /合成目标.*1\/2/s);
  assert.doesNotMatch((await answer('goals')).json().text, /密码|说明/);
  assert.doesNotMatch((await answer('knowledge', { query: '星图' }, other)).json().text, /北窗/);
  assert.equal((await repository.read(id)).revision, 9);
  await repository.apply(id, 9, { type: 'deleteMemory', id: savedID });
  assert.doesNotMatch((await answer('knowledge', { query: '星图' })).json().text, /北窗/);
  assert.ok((await workspace.mutate('delete', { expectedRevision: 2, id })).ok);
  assert.deepEqual((await answer('goals')).json(), { ok: false, error: 'not-found' });
});

test('chat approval uses fixed authenticated, revision-bound operations and never dispatches chat', { skip: process.platform === 'win32' }, async t => {
  const { app, request, id, other } = await setupRecordRoutes(t);
  assert.equal((await request('identity/save', { expectedRevision: 0, draft: identity })).statusCode, 200);
  const grant = (expectedRevision: number, enabled: boolean) => ({ expectedRevision, enabled });
  assert.equal((await app.inject({ method: 'POST', url: `/v1/characters/${id}/identity/chat-share`, headers: { host: '127.0.0.1' }, payload: grant(1, true) })).statusCode, 401);
  assert.equal((await request('identity/chat-share', { ...grant(1, true), url: 'https://example.invalid' })).statusCode, 400);
  assert.equal((await request('identity/chat-share', grant(1, true), 'unregistered')).statusCode, 404);
  const saved = await request('identity/chat-share', grant(1, true));
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().snapshot.identity.chatShare, true);
  assert.equal((await request('identity/chat-share', grant(1, false))).statusCode, 409);
  const added = (await request('memories/add', { expectedRevision: 2, draft: { kind: '偏好', text: '爱看合成动画', source: '', citation: '', version: '' } })).json();
  const memory = added.snapshot.records[0].id;
  const shareMemory = (expectedRevision: number, enabled: boolean, pet = id) => request('memories/chat-share', { ...grant(expectedRevision, enabled), id: memory }, pet);
  assert.equal((await shareMemory(3, true)).statusCode, 400);
  assert.equal((await shareMemory(0, true, other)).statusCode, 404);
  assert.equal((await request('memories/confirm', { expectedRevision: 3, id: memory })).statusCode, 200);
  assert.equal((await shareMemory(4, true)).json().snapshot.records[0].chatShare, true);
  assert.equal((await shareMemory(5, false)).json().snapshot.records[0].chatShare, undefined);
  const goal = (await request('goals/add', { expectedRevision: 6, draft: { title: '写例子', details: '', status: '进行中', steps: [] } })).json().snapshot.records[0];
  assert.equal((await request('goals/chat-share', { ...grant(7, true), id: goal.id })).json().snapshot.records[0].chatShare, true);
  assert.equal((await request('chat/send', { message: '合成问题' })).statusCode, 404);
});
