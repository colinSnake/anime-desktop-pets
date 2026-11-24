import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOnlineChatContext, onlineChatContextBytes, prepareOnlineChatContext } from '../src/characters/online-chat-context.ts';
import type { CharacterState } from '../src/characters/records.ts';
import { CharacterRepository } from '../src/characters/repository.ts';
import { PetWorkspace } from '../src/pet-workspace.ts';
import type { Memory, Goal } from '../../../packages/contracts/src/character-records.ts';

const now = '2026-11-18T12:00:00.000Z', old = '2026-11-17T00:00:00.000Z';
const record = { revision: 1, createdAt: old, updatedAt: old };
const id = (n: number) => `00000000-0000-0000-0000-${n.toString().padStart(12, '0')}`;
const identity = { name: '纸船助手', role: '合成伙伴', background: '私有背景', personality: '耐心', values: '', motivations: '', relationship: '私有关系', speakingStyle: '直接', knowledgeScope: '', boundaries: '守住边界' };
const memory = (n: number, text: string, patch: Partial<Memory> = {}): Memory => ({ ...record, id: id(n), kind: '事实', text,
  source: '', citation: '', version: '', status: 'confirmed', confirmedAt: old, ...patch } as Memory);
const goal = (n: number, title: string, patch: Partial<Goal> = {}): Goal => ({ ...record, id: id(n), title, details: '隐私目标细节', status: '进行中',
  steps: [{ id: id(100 + n), text: '隐私步骤内容', isComplete: true }], ...patch });
const stateOf = (values: Partial<CharacterState> = {}): CharacterState => ({ schemaVersion: 1, petID: 'pet-a', revision: 1,
  identity: null, identityHistory: [], memories: [], goals: [], ...values });
const rows = (...records: Memory[]): CharacterState['memories'] => records.map(current => ({ current, history: [] }));
const knowledge = { kind: '知识', source: '折纸手册', citation: '第三章', version: '第二版' } as const;

test('only current, authorized and relevant records contribute minimal online chat context', () => {
  const state = stateOf({ identity: { ...record, ...identity, chatShare: true }, identityHistory: [{ ...record, ...identity, name: '私有旧身份' }],
    memories: rows(memory(1, '未授权的纸船', {}), memory(2, '喜欢蓝色纸船', { chatShare: true, source: '隐私个人来源' }),
      memory(3, '待确认纸船', { chatShare: true, status: 'candidate', confirmedAt: undefined }),
      memory(4, '爬山', { chatShare: true }), memory(5, '纸船访问密码', { chatShare: true }),
      memory(6, '纸船的龙骨向内折', { ...knowledge, chatShare: true }), memory(7, '过期纸船知识', { ...knowledge, citation: '到期章', chatShare: true, expiresAt: now })),
    goals: [goal(8, '纸船展览', { chatShare: true }), goal(9, '纸船相册'), goal(10, '每日散步', { chatShare: true }), goal(11, '纸船验证码', { chatShare: true })],
  });
  assert.deepEqual(buildOnlineChatContext(state, '聊聊纸船', now), {
    identity: { name: identity.name, role: identity.role, personality: identity.personality, speakingStyle: identity.speakingStyle, boundaries: identity.boundaries },
    personalMemories: ['喜欢蓝色纸船'], roleKnowledge: [{ text: '纸船的龙骨向内折', source: '折纸手册', citation: '第三章', version: '第二版' }],
    goals: [{ title: '纸船展览', status: '进行中', completed: 1, total: 1 }],
  });
  assert.deepEqual(buildOnlineChatContext(stateOf({ identity: { ...record, ...identity } }), '纸船', now), {});
  assert.deepEqual(buildOnlineChatContext(stateOf({ identity: { ...record, ...identity, boundaries: '勿透露 API key', chatShare: true } }), '纸船', now), {});
  assert.deepEqual(buildOnlineChatContext(state, '磁悬浮列车', now), { identity: { name: identity.name, role: identity.role, personality: identity.personality, speakingStyle: identity.speakingStyle, boundaries: identity.boundaries } });
  assert.deepEqual(buildOnlineChatContext(state, '你是谁？', now), { identity: { name: identity.name, role: identity.role, personality: identity.personality, speakingStyle: identity.speakingStyle, boundaries: identity.boundaries } });
  for (const text of ['查看本机身份', '查看目标进度', '查个人记忆：', '查角色知识：纸船', '纸船密码']) assert.deepEqual(buildOnlineChatContext(state, text, now), {});
});

test('knowledge conflicts include unshared records, while unshared and oversized matches cannot take the available slots', () => {
  const state = stateOf({ memories: rows(
    memory(1, '纸船的第一种折法', { ...knowledge, chatShare: true }), memory(2, '纸船的另一种折法', knowledge),
    memory(3, '纸船' + '大'.repeat(996), { ...knowledge, citation: '过大段落', chatShare: true }),
    ...Array.from({ length: 5 }, (_, n) => memory(n + 10, `关于纸船的段落 ${n}`, { ...knowledge, citation: `其他章节 ${n}`, ...(n === 0 ? {} : { chatShare: true }) })),
    ...Array.from({ length: 5 }, (_, n) => memory(n + 20, `我的纸船 ${n}`, { chatShare: true })),
  ) });
  const context = buildOnlineChatContext(state, '纸船', now);
  assert.deepEqual(context.roleKnowledge?.map(item => item.text), ['关于纸船的段落 1', '关于纸船的段落 2', '关于纸船的段落 3']);
  assert.deepEqual(context.personalMemories, ['我的纸船 0', '我的纸船 1', '我的纸船 2']);
  assert.ok(Buffer.byteLength(JSON.stringify(context)) <= onlineChatContextBytes);
});

test('online context assembly reads the authorized version from the current registered instance and never caches it', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'adp-chat-context-'));
  const pkg = { id: 'local.pet', version: '1.0.0' };
  const workspace = new PetWorkspace({ root, catalog: [{ ...pkg, name: '合成桌宠' }] });
  const repo = new CharacterRepository(join(root, 'characters'), { clock: () => new Date(now) });
  t.after(async () => { await repo.close(); await rm(root, { recursive: true, force: true }); });
  const first = await workspace.mutate('add', { expectedRevision: 0, package: pkg });
  const second = await workspace.mutate('add', { expectedRevision: 1, package: pkg });
  assert.ok(first.ok && second.ok);
  const a = first.workspace.instances[0]!.id, b = second.workspace.instances.find(pet => pet.id !== a)!.id;
  const question = '纸船';
  const read = (petID: string) => prepareOnlineChatContext(workspace, repo, petID, question, now);
  const added = await repo.apply(a, 0, { type: 'addMemory', value: { kind: '事实', text: '蓝色纸船', source: '', citation: '', version: '' } });
  const entry = added.state.memories[0]!.current.id;
  await repo.apply(a, 1, { type: 'confirmMemory', id: entry });
  await repo.apply(a, 2, { type: 'setMemoryChatShare', id: entry, enabled: true });
  assert.deepEqual(await read(a), { characterRevision: 3, context: { personalMemories: ['蓝色纸船'] } });
  assert.deepEqual(await read(b), { characterRevision: 0, context: {} });
  await repo.apply(a, 3, { type: 'setMemoryChatShare', id: entry, enabled: false });
  assert.deepEqual((await read(a)).context, {});
  await repo.apply(a, 4, { type: 'setMemoryChatShare', id: entry, enabled: true });
  await repo.apply(a, 5, { type: 'deleteMemory', id: entry });
  assert.deepEqual((await read(a)).context, {});
  const removing = workspace.mutate('delete', { expectedRevision: 2, id: a });
  await assert.rejects(read(a), { code: 'not-found' });
  assert.ok((await removing).ok);
});

test('serialized context enforces the combined byte budget without cutting Unicode or evidence pairs', () => {
  const marker = '折纸船';
  const state = stateOf({ identity: { ...record, ...identity, chatShare: true, personality: '友'.repeat(440) },
    memories: rows(...Array.from({ length: 3 }, (_, n) => memory(n + 1, `${marker}${n}${'蓝'.repeat(240)}`, { chatShare: true })),
      ...Array.from({ length: 3 }, (_, n) => memory(n + 4, `${marker}${n}${'海'.repeat(350)}`, { ...knowledge, citation: `依据 ${n}`, chatShare: true }))),
    goals: Array.from({ length: 3 }, (_, n) => goal(n + 7, `${marker}${n}${'标'.repeat(100)}`, { chatShare: true })),
  });
  const result = buildOnlineChatContext(state, marker, now);
  assert.ok(result.identity);
  assert.equal(result.personalMemories?.length, 3);
  assert.ok((result.roleKnowledge?.length ?? 0) < 3);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= onlineChatContextBytes);
  for (const item of result.roleKnowledge ?? []) {
    assert.ok(state.memories.some(({ current }) => current.text === item.text && current.source === item.source && current.citation === item.citation));
  }
});
