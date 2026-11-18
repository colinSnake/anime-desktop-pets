import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { type Goal, type Memory, type MemoryHistoryResult, type MemoryHistorySnapshot, type RecordSnapshot, type RecordWriteResult } from '../../../packages/contracts/src/character-records.ts';
import { createMemorySession, emptyMemory, createGoalSession, emptyGoal, goalFormOf } from '../src/pages/character-record-editors.ts';
import type { KnowledgeSearchResult } from '../../../packages/contracts/src/knowledge-search.ts';
import type { KnowledgeFileResult } from '../../../packages/contracts/src/knowledge-import.ts';
import { MemoryPage } from '../src/pages/MemoryPage.tsx';
import { GoalsPage } from '../src/pages/GoalsPage.tsx';
import { RecordWorkspace } from '../src/pages/record-session.ts';

const notCalled = async () => assert.fail('unexpected request');
const memoryWriteStubs = { deleteMemory: notCalled, setMemoryChatShare: notCalled, searchKnowledge: notCalled, addKnowledgeBatch: notCalled, selectKnowledgeFile: notCalled, readMemoryHistory: notCalled, editMemory: notCalled, restoreMemory: notCalled };
const memory = { kind: '事实', text: '合成记忆', source: '手动记录', citation: '', version: '' } as const;
const stamp = '2026-11-18T00:00:00.000Z', key = '00000000-0000-0000-0000-000000000001';
const saved = { ...memory, id: key, status: 'candidate', revision: 1, createdAt: stamp, updatedAt: stamp } as const;
const snapshot = <T extends Goal | Memory>(petID: string, revision: number, records: T[] = []): RecordSnapshot<T> => ({ schemaVersion: 1, petID, revision, records });
const ok = <T extends Goal | Memory>(value: RecordSnapshot<T>) => ({ ok: true as const, snapshot: value });
const binding = <T,>(value: T) => ({ value, update: () => assert.fail('SSR must not edit drafts') });
const pet = { id: 'pet-one', displayName: '测试桌宠' };

test('memory candidate review is explicit; stale results preserve the per-instance draft and require a reload', async () => {
  let observed = snapshot<Memory>(pet.id, 1, [saved]), writes = 0;
  const session = createMemorySession({ ...memoryWriteStubs, readMemories: async () => ok(observed), addMemory: async input => {
    assert.equal(input.expectedRevision, 1);
    assert.equal(input.draft.text, '待存草稿'); writes++;
    return { ok: false, error: 'conflict' };
  }, confirmMemory: notCalled, withdrawMemory: notCalled }, pet.id);
  await session.load();
  session.updateDraft(d => ({ ...d, personal: { ...d.personal, text: '待存草稿' } }));
  const html = () => renderToStaticMarkup(createElement(MemoryPage, { mode: 'personal', onMode() {}, personal: binding(emptyMemory), knowledge: binding(emptyMemory), connected: true, instance: pet, session }));
  assert.match(html(), /合成记忆/);
  assert.match(html(), /<button(?:(?!disabled)[^>])*>确认记忆<\/button>/);
  await session.add('personal'); await session.add('personal');
  assert.equal(writes, 1);
  assert.equal(session.getSnapshot().draft.personal.text, '待存草稿');
  assert.match(html(), /读取最新资料/);
  observed = snapshot<Memory>(pet.id, 2, [{ ...saved, status: 'confirmed', confirmedAt: stamp }]);
  await session.load();
  assert.match(html(), /撤回确认/);
  assert.equal(session.getSnapshot().draft.personal.text, '待存草稿');
});

test('goal progress stays a draft until saved and cannot replace a newer version after refresh', async () => {
  const old: Goal = { title: '合成目标', details: '', status: '进行中', id: key, revision: 1, createdAt: stamp, updatedAt: stamp, steps: [{ id: key, text: '读一页', isComplete: false }] };
  let source = snapshot<Goal>(pet.id, 1, [old]), seen: unknown;
  const session = createGoalSession({ deleteGoal: notCalled, setGoalChatShare: notCalled, readGoals: async () => ok(source), addGoal: notCalled, editGoal: async input => {
    seen = input;
    return { ok: false, error: 'conflict' };
  } }, pet.id);
  await session.load();
  session.updateDraft(goalFormOf(old));
  session.updateDraft(d => ({ ...d, changed: true, steps: [{ ...d.steps[0]!, done: true }] }));
  const html = () => renderToStaticMarkup(createElement(GoalsPage, { mode: 'plan', onMode() {}, draft: binding(emptyGoal), connected: true, instance: pet, session }));
  assert.match(html(), /1 \/ 1 已完成/);
  assert.match(html(), /0 \/ 1 步已完成/);
  await session.save();
  assert.deepEqual(seen, { petID: pet.id, expectedRevision: 1, id: key, draft: { title: old.title, details: '', status: '进行中', steps: [{ id: key, text: '读一页', isComplete: true }] } });
  source = snapshot(pet.id, 2, [{ ...old, revision: 2, details: '外部更新' }]);
  await session.load();
  assert.match(html(), /已保存的目标有更新/);
  assert.match(html(), /<button[^>]*disabled=""[^>]*>保存目标<\/button>/);
  assert.equal(session.getSnapshot().draft.steps[0]?.done, true);
});

test('retiring an instance drops any late write while a different instance keeps its own drafts', async () => {
  let settle!: (result: RecordWriteResult<Memory>) => void;
  const workspace = new RecordWorkspace(petID => createMemorySession({ ...memoryWriteStubs, readMemories: async () => ok(snapshot<Memory>(petID, 0)),
    addMemory: () => new Promise(resolve => { settle = resolve; }), confirmMemory: notCalled, withdrawMemory: notCalled }, petID));
  const a = workspace.forPet('pet-a'), b = workspace.forPet('pet-b');
  await a.load(); await b.load();
  a.updateDraft(d => ({ ...d, personal: { ...emptyMemory, text: '草稿甲' } }));
  b.updateDraft(d => ({ ...d, personal: { ...emptyMemory, text: '草稿乙' } }));
  const pending = a.add('personal');
  workspace.keepRegistered(['pet-b']);
  settle({ ...ok(snapshot('pet-a', 1, [saved])), durability: 'confirmed' }); await pending;
  assert.equal(a.getSnapshot().snapshot, undefined);
  assert.equal(b.getSnapshot().draft.personal.text, '草稿乙');
  assert.equal(b.getSnapshot().snapshot?.revision, 0);
});

test('unconfirmed candidate writes block repeat submission until a successful read and do not clear either draft', async () => {
  let observed = snapshot<Memory>(pet.id, 0), failRead = false, adds = 0;
  const session = createMemorySession({
    ...memoryWriteStubs, readMemories: async () => failRead ? { ok: false, error: 'unavailable' } : ok(observed),
    addMemory: async input => {
      adds++;
      observed = snapshot(pet.id, 1, [{ ...saved, ...input.draft }]);
      return { ...ok(observed), durability: 'unconfirmed' };
    }, confirmMemory: notCalled, withdrawMemory: notCalled,
  }, pet.id);
  await session.load();
  session.updateDraft({ personal: { ...emptyMemory, text: '待确认写入' }, knowledge: { ...emptyMemory, text: '另一分类草稿' } });
  await session.add('personal');
  assert.equal(session.getSnapshot().error, 'write-outcome-unknown');
  assert.equal(session.getSnapshot().snapshot?.revision, 0);
  await session.add('personal');
  failRead = true;
  await session.load(); await session.add('personal');
  assert.equal(session.getSnapshot().needsRead, true);
  assert.equal(adds, 1);
  failRead = false;
  await session.load();
  assert.equal(session.getSnapshot().notice, 'reloaded');
  assert.equal(session.getSnapshot().snapshot?.records[0]?.text, '待确认写入');
  assert.equal(session.getSnapshot().draft.personal.text, '待确认写入');
  assert.equal(session.getSnapshot().draft.knowledge.text, '另一分类草稿');
});

test('a confirmed addition clears only the submitted category and reviews stored candidates by ID', async () => {
  const actions: string[] = [];
  const session = createMemorySession({ ...memoryWriteStubs, readMemories: async () => ok(snapshot<Memory>(pet.id, 0)),
    addMemory: async input => {
      assert.equal(input.draft.kind, '知识');
      assert.equal(input.draft.expiresAt, '2027-01-31T23:59:59.999Z');
      return { ...ok(snapshot<Memory>(pet.id, 1, [{ ...saved, ...input.draft }])), durability: 'confirmed' };
    }, confirmMemory: async input => {
      actions.push(input.id);
      const record = session.getSnapshot().snapshot!.records[0]!;
      return { ...ok(snapshot<Memory>(pet.id, 2, [{ ...record, status: 'confirmed', confirmedAt: stamp }])), durability: 'confirmed' };
    }, withdrawMemory: notCalled,
  }, pet.id);
  await session.load();
  session.updateDraft({ personal: { ...emptyMemory, text: '另一分类草稿' }, knowledge: { ...emptyMemory, text: '待确定知识', source: '测试来源', expiresAt: '2027-01-31' } });
  await session.add('knowledge');
  assert.equal(session.getSnapshot().draft.personal.text, '另一分类草稿');
  assert.equal(session.getSnapshot().draft.knowledge.text, '');
  await session.review(key, 'confirmMemory');
  await session.review(key, 'confirmMemory');
  assert.deepEqual(actions, [key]);
  assert.equal(session.getSnapshot().snapshot?.records[0]?.status, 'confirmed');
});

test('memory edit is inline, preserves the addition draft and blocks a stale content revision after reload', async () => {
  let calls = 0;
  const confirmed: Memory = { ...saved, status: 'confirmed', confirmedAt: stamp, kind: '知识', expiresAt: '2027-01-31T10:00:00.000Z' };
  let source = snapshot<Memory>(pet.id, 2, [confirmed]);
  const session = createMemorySession({ ...memoryWriteStubs, readMemories: async () => ok(source), addMemory: notCalled, confirmMemory: notCalled, withdrawMemory: notCalled,
    editMemory: async ({ petID, id, expectedRevision, draft }) => {
      assert.deepEqual({ petID, id, expectedRevision, draft }, { petID: pet.id, id: key, expectedRevision: 2, draft: {
        ...memory, kind: '知识', text: '编辑后的草稿', expiresAt: confirmed.expiresAt,
      } });
      calls++;
      return { ok: false, error: 'conflict' };
    },
  }, pet.id);
  await session.load();
  session.updateDraft(forms => ({ ...forms, knowledge: { ...emptyMemory, text: '原新增草稿' } }));
  session.startEdit(key);
  session.updateEdit(form => ({ ...form, text: '编辑后的草稿' }));
  const html = () => renderToStaticMarkup(createElement(MemoryPage, { mode: 'knowledge', onMode() {}, personal: binding(emptyMemory), knowledge: binding(emptyMemory), connected: true, instance: pet, session }));
  assert.match(html(), /编辑角色知识/);
  assert.match(html(), /编辑后的草稿/);
  assert.match(html(), /查看历史/);
  assert.match(html(), /重新确认/);
  await session.saveEdit();
  assert.equal(session.getSnapshot().needsRead, true);
  source = snapshot<Memory>(pet.id, 3, [{ ...confirmed, revision: 2, text: '磁盘已更新' }]);
  await session.load();
  assert.match(html(), /已保存的资料有更新/);
  assert.match(html(), /<button[^>]*disabled=""[^>]*>保存修改<\/button>/);
  await session.saveEdit();
  assert.equal(calls, 1);
  session.cancelEdit();
  assert.match(html(), /原新增草稿/);
});

test('memory history requires a matching preview, protects edits and drops late reads after refresh or retirement', async () => {
  let release!: (result: MemoryHistoryResult) => void;
  let calls = 0;
  const current = { ...saved, revision: 2, text: '当前版本' };
  let source = snapshot<Memory>(pet.id, 5, [current]);
  let history: MemoryHistorySnapshot = { schemaVersion: 1, petID: pet.id, id: key, revision: 5, currentRevision: 2, history: [saved] };
  const session = createMemorySession({ ...memoryWriteStubs, readMemories: async () => ok(source), addMemory: notCalled, confirmMemory: notCalled, withdrawMemory: notCalled,
    readMemoryHistory: ({ petID, id }) => {
      assert.deepEqual({ petID, id }, { petID: pet.id, id: key });
      return new Promise(resolve => { release = resolve; });
    },
    restoreMemory: async request => {
      calls++;
      assert.deepEqual(request, { petID: pet.id, id: key, expectedRevision: 6, historicalRevision: 1 });
      return { ...ok(snapshot(pet.id, 7, [{ ...saved, revision: 3 }])), durability: 'confirmed' };
    },
  }, pet.id);
  await session.load();
  const stale = session.readHistory(key);
  source = snapshot<Memory>(pet.id, 6, [current]);
  await session.load();
  release({ ok: true, snapshot: history });
  assert.equal(await stale, undefined);
  await session.restoreHistory(history, 1);
  history = { ...history, revision: 6 };
  const pending = session.readHistory(key);
  release({ ok: true, snapshot: history });
  assert.deepEqual(await pending, { ok: true, snapshot: history });
  await session.restoreHistory(history, 2);
  session.startEdit(key);
  await session.restoreHistory(history, 1);
  assert.equal(calls, 0);
  session.cancelEdit();
  await session.restoreHistory(history, 1);
  assert.equal(calls, 1);
  assert.equal(session.getSnapshot().snapshot?.records[0]?.status, 'candidate');
  const late = session.readHistory(key);
  session.retire();
  release({ ok: true, snapshot: history });
  assert.equal(await late, undefined);
});

test('previewing imported paragraphs is read-only and commits them to review only after explicit save', async () => {
  const paragraphs = ['<b>合成正文</b>', '另一段合成知识'];
  let submits = 0;
  const session = createMemorySession({ ...memoryWriteStubs, readMemories: async () => ok(snapshot<Memory>(pet.id, 0)),
    addMemory: notCalled, confirmMemory: notCalled, withdrawMemory: notCalled,
    selectKnowledgeFile: async (...args) => { assert.deepEqual(args, []); return { ok: true, paragraphs }; },
    addKnowledgeBatch: async ({ petID, expectedRevision, drafts }) => {
      submits++;
      assert.equal(petID, pet.id);
      assert.equal(expectedRevision, 0);
      assert.deepEqual(drafts, paragraphs.map((text, i) => ({ kind: '知识', text, source: '合成手册', citation: `第 3 节（导入文本第 ${i + 1} 段）`, version: '' })));
      return { ...ok(snapshot<Memory>(pet.id, 1, drafts.map((draft, i) => ({ ...saved, ...draft, id: `${key.slice(0, -1)}${i + 1}` })))), durability: 'confirmed' };
    },
  }, pet.id);
  await session.load();
  session.updateDraft(forms => ({ ...forms, knowledge: { ...emptyMemory, text: '普通新增草稿' } }));
  const html = () => renderToStaticMarkup(createElement(MemoryPage, { mode: 'knowledge', onMode() {}, personal: binding(emptyMemory), knowledge: binding(emptyMemory), connected: true, instance: pet, session }));
  assert.match(html(), /<button(?:(?!disabled)[^>])*>选择文本文件<\/button>/);
  assert.deepEqual(await session.chooseKnowledgeFile(() => true), { ok: true, paragraphs });
  assert.match(html(), /预检 2 段/);
  assert.match(html(), /&lt;b&gt;合成正文&lt;\/b&gt;/);
  await session.saveKnowledgeImport();
  assert.equal(submits, 0);
  session.updateKnowledgeImport(form => ({ ...form, source: '合成手册', citation: '第 3 节' }));
  assert.equal(session.getSnapshot().snapshot?.records.length, 0);
  await session.saveKnowledgeImport();
  assert.equal(submits, 1);
  assert.equal(session.getSnapshot().draft.knowledgeImport, undefined);
  assert.equal(session.getSnapshot().draft.knowledge.text, '普通新增草稿');
  assert.deepEqual(session.getSnapshot().snapshot?.records.map(record => record.status), ['candidate', 'candidate']);
});

test('knowledge previews preserve metadata after uncertain publication and block an overlapping retry after reload', async () => {
  let source = snapshot<Memory>(pet.id, 0), submits = 0;
  const session = createMemorySession({ ...memoryWriteStubs, readMemories: async () => ok(source), addMemory: notCalled, confirmMemory: notCalled, withdrawMemory: notCalled,
    selectKnowledgeFile: async () => ({ ok: true, paragraphs: ['合成知识'] }),
    addKnowledgeBatch: async ({ drafts }) => {
      submits++;
      source = snapshot<Memory>(pet.id, 1, [{ ...saved, ...drafts[0]! }]);
      return { ...ok(source), durability: 'unconfirmed' };
    },
  }, pet.id);
  await session.load();
  await session.chooseKnowledgeFile(() => true);
  session.updateKnowledgeImport(form => ({ ...form, source: '合成来源' }));
  await session.saveKnowledgeImport(); await session.saveKnowledgeImport();
  assert.equal(session.getSnapshot().needsRead, true);
  assert.equal(session.getSnapshot().draft.knowledgeImport?.form.source, '合成来源');
  await session.load(); await session.saveKnowledgeImport();
  assert.equal(submits, 1);
  const html = renderToStaticMarkup(createElement(MemoryPage, { mode: 'knowledge', onMode() {}, personal: binding(emptyMemory), knowledge: binding(emptyMemory), connected: true, instance: pet, session }));
  assert.match(html, /已有相同知识/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>将 1 段加入待确认<\/button>/);
  session.cancelKnowledgeImport();
  assert.equal(session.getSnapshot().draft.knowledgeImport, undefined);
});

test('knowledge picker drops late results after switching or retiring the instance', async () => {
  let settle!: (value: KnowledgeFileResult) => void;
  let active = true;
  const session = createMemorySession({ ...memoryWriteStubs, readMemories: async () => ok(snapshot<Memory>(pet.id, 0)),
    addMemory: notCalled, confirmMemory: notCalled, withdrawMemory: notCalled,
    selectKnowledgeFile: () => new Promise(resolve => { settle = resolve; }),
  }, pet.id);
  await session.load();
  const first = session.chooseKnowledgeFile(() => active);
  active = false;
  settle({ ok: true, paragraphs: ['迟到正文'] });
  assert.equal(await first, undefined);
  assert.equal(session.getSnapshot().draft.knowledgeImport, undefined);
  const second = session.chooseKnowledgeFile(() => true);
  session.retire();
  settle({ ok: true, paragraphs: ['删除后正文'] });
  assert.equal(await second, undefined);
  assert.equal(session.getSnapshot().draft.knowledgeImport, undefined);
});

const secondKey = '00000000-0000-0000-0000-000000000002';
const thirdKey = '00000000-0000-0000-0000-000000000003';
const fourthKey = '00000000-0000-0000-0000-000000000004';
const fifthKey = '00000000-0000-0000-0000-000000000005';
const recalled = { ...saved, kind: '知识', status: 'confirmed', confirmedAt: stamp, text: '合成观测知识',
  source: '观测手册', citation: '第 2 页', version: '第二版' } as const;
const searchResult = (ids: string[]): KnowledgeSearchResult => ({ ok: true, petID: pet.id, revision: 5, ids });

test('local knowledge search maps IDs in service order, rejects invalid matches and leaves record drafts untouched', async () => {
  let reply = searchResult([secondKey, key]);
  let calls = 0;
  const second = { ...recalled, id: secondKey, text: '另一合成观测' };
  const data = snapshot<Memory>(pet.id, 5, [recalled, second, { ...saved, id: thirdKey, kind: '知识' },
    { ...saved, id: fourthKey, status: 'confirmed', confirmedAt: stamp }, { ...recalled, id: fifthKey, createdAt: '2000-01-01T00:00:00.000Z', updatedAt: '2000-01-01T00:00:00.000Z',
      confirmedAt: '2000-01-01T00:00:00.000Z', expiresAt: '2000-01-02T00:00:00.000Z' }]);
  const session = createMemorySession({ ...memoryWriteStubs, readMemories: async () => ok(data), addMemory: notCalled,
    confirmMemory: notCalled, withdrawMemory: notCalled, searchKnowledge: async input => {
      calls++;
      assert.deepEqual(input, { petID: pet.id, expectedRevision: 5, query: '合成观测' });
      return reply;
    },
  }, pet.id);
  const page = (mode: 'personal' | 'knowledge') => renderToStaticMarkup(createElement(MemoryPage, {
    mode, onMode() {}, personal: binding(emptyMemory), knowledge: binding(emptyMemory), connected: true, instance: pet, session,
  }));
  assert.equal(await session.searchKnowledge('合成观测'), undefined);
  assert.match(page('knowledge'), /<button[^>]*disabled=""[^>]*>搜索角色知识<\/button>/);
  await session.load();
  assert.equal(session.getSnapshot().snapshot, data);
  session.updateDraft(d => ({ ...d, knowledge: { ...d.knowledge, text: '编辑中的草稿' } }));
  const before = session.getSnapshot();
  assert.doesNotMatch(page('personal'), /搜索角色知识/);
  assert.match(page('knowledge'), /maxlength="120"/i);
  assert.deepEqual(await session.searchKnowledge('合成观测'), { ok: true, matches: [second, recalled] });
  assert.deepEqual(await session.searchKnowledge(' '), { ok: false, error: 'invalid' });
  assert.equal(calls, 1);
  for (const id of [thirdKey, fourthKey, fifthKey, '00000000-0000-0000-0000-000000000006']) {
    reply = searchResult([key, id]);
    assert.deepEqual(await session.searchKnowledge('合成观测'), { ok: false, error: 'unavailable' });
  }
  reply = searchResult([]);
  assert.deepEqual(await session.searchKnowledge('合成观测'), { ok: true, matches: [] });
  reply = { ok: false, error: 'conflict' };
  assert.deepEqual(await session.searchKnowledge('合成观测'), reply);
  assert.equal(session.getSnapshot(), before);
});

test('any read or write invalidates a pending search even at the same revision, and retirement drops late replies', async () => {
  let resolve!: (result: KnowledgeSearchResult) => void;
  const data = snapshot<Memory>(pet.id, 5, [recalled]);
  const session = createMemorySession({ ...memoryWriteStubs, readMemories: async () => ok(data), addMemory: notCalled,
    confirmMemory: notCalled, withdrawMemory: async () => ({ ok: false, error: 'busy' }),
    searchKnowledge: () => new Promise(done => { resolve = done; }),
  }, pet.id);
  await session.load();
  for (const invalidate of [() => session.load(), () => session.review(key, 'withdrawMemory'), () => session.retire()]) {
    const pending = session.searchKnowledge('合成观测');
    await invalidate();
    resolve(searchResult([key]));
    assert.equal(await pending, undefined);
  }
});

test('memory deletion requires a current explicit confirmation and preserves other drafts', async () => {
  let records = snapshot<Memory>(pet.id, 5, [recalled]);
  let calls = 0;
  const session = createMemorySession({ ...memoryWriteStubs, readMemories: async () => ok(records), addMemory: notCalled, confirmMemory: notCalled, withdrawMemory: notCalled,
    deleteMemory: async input => {
      calls++;
      assert.deepEqual(input, { petID: pet.id, expectedRevision: 5, id: key });
      records = snapshot(pet.id, 6);
      return { ...ok(records), durability: 'confirmed' };
    },
  }, pet.id);
  const html = () => renderToStaticMarkup(createElement(MemoryPage, { mode: 'knowledge', onMode() {}, personal: binding(emptyMemory), knowledge: binding(emptyMemory), connected: true, instance: pet, session }));
  await session.load();
  session.updateDraft(d => ({ ...d, personal: { ...d.personal, text: '保留草稿' } }));
  await session.confirmDelete(key);
  session.startEdit(key);
  session.requestDelete(key);
  assert.doesNotMatch(html(), /确认删除知识/);
  session.cancelEdit();
  session.requestDelete(key);
  assert.match(html(), /确认删除知识/);
  assert.match(html(), /历史版本/);
  await session.confirmDelete(secondKey);
  assert.equal(calls, 0);
  session.cancelDelete();
  await session.confirmDelete(key);
  session.requestDelete(key);
  await session.load();
  await session.confirmDelete(key);
  assert.equal(calls, 0);
  session.requestDelete(key);
  await Promise.all([session.confirmDelete(key), session.confirmDelete(key)]);
  assert.equal(calls, 1);
  assert.doesNotMatch(html(), /合成观测知识|确认删除知识/);
  assert.match(html(), /已删除所选资料/);
  assert.equal(session.getSnapshot().draft.personal.text, '保留草稿');
});

test('goal deletion retains a different draft and requires a reload after uncertain publication', async () => {
  const current: Goal = { title: '保存目标', details: '', status: '进行中', id: key, revision: 1, createdAt: stamp, updatedAt: stamp, steps: [] };
  const other = { ...current, id: secondKey, title: '其它目标' };
  let projection = snapshot<Goal>(pet.id, 8, [current, other]);
  let calls = 0;
  const session = createGoalSession({ readGoals: async () => ok(projection), addGoal: notCalled, editGoal: notCalled,
    setGoalChatShare: notCalled,
    deleteGoal: async input => {
      calls++;
      assert.deepEqual(input, { petID: pet.id, expectedRevision: 8, id: key });
      projection = snapshot(pet.id, 9, [other]);
      return { ...ok(projection), durability: 'unconfirmed' };
    },
  }, pet.id);
  await session.load();
  session.updateDraft({ ...goalFormOf(other), changed: true, detail: '未保存草稿' });
  session.requestDelete(key);
  assert.match(renderToStaticMarkup(createElement(GoalsPage, { mode: 'plan', onMode() {}, draft: binding(emptyGoal), connected: true, instance: pet, session })), /确认删除目标/);
  await session.confirmDelete(key);
  session.requestDelete(key);
  await session.confirmDelete(key);
  assert.equal(calls, 1);
  assert.equal(session.getSnapshot().error, 'write-outcome-unknown');
  assert.equal(session.getSnapshot().snapshot?.records[0]?.id, key);
  await session.load();
  assert.equal(session.getSnapshot().snapshot?.records[0]?.id, secondKey);
  assert.equal(session.getSnapshot().draft.detail, '未保存草稿');
  await session.confirmDelete(key);
  assert.equal(calls, 1);
});
