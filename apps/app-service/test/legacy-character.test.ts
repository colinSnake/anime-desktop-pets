import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { decodeLegacyGoal, decodeLegacyIdentity, decodeLegacyMemory } from '../src/migration/legacy-character.ts';

const id = 'c015a3d1-25c1-41d7-bdbc-a3ac4cab2547';
const stepID = 'c015a3d1-25c1-41d7-bdbc-a3ac4cab2345';
const time = '2026-11-15T00:00:00Z';
const clock = '2026-11-18T03:00:00Z';
const markdown = (meta: object, body: string) => Buffer.from(`---\n${JSON.stringify(meta, null, 2)}\n---\n\n${body}\n`);
const identity = { schema: 2, shareWithOnlineModel: false, createdAt: time, updatedAt: clock, revision: 7 };
const memory = { schema: 4, id, kind: '知识', createdAt: time, updatedAt: clock, revision: 3, source: '合成资料', citation: '第 2 节', version: 'v1', expiresAt: clock, status: 'candidate', shareWithOnlineModel: true };
const goal = { schema: 2, id, createdAt: time, status: '已暂停', shareWithOnlineModel: false };

test('legacy identity preserves multiline fields, time, sharing and identity revision', () => {
  const body = '# 龙妹\n\n## 身份定位\n桌面伙伴\n陪你工作\n\n## 表达方式\n简洁\n\n## 边界\n不自动执行任务';
  const record = decodeLegacyIdentity(markdown(identity, body), clock);
  assert.equal(record.sourceSchema, 2); assert.equal(record.name, '龙妹');
  assert.equal(record.role, '桌面伙伴\n陪你工作'); assert.equal(record.speakingStyle, '简洁');
  assert.equal(record.boundaries, '不自动执行任务'); assert.equal(record.background, '');
  assert.equal(record.createdAt, time); assert.equal(record.updatedAt, clock);
  assert.equal(record.revision, 7); assert.equal(record.recordedShareWithOnlineModel, false);
  const old = decodeLegacyIdentity(markdown({ schema: 1, shareWithOnlineModel: true }, '# 龙妹'), clock);
  assert.equal(old.revision, 1); assert.equal(old.createdAt, clock); assert.equal(old.updatedAt, clock); assert.equal(old.recordedShareWithOnlineModel, true);
});

test('legacy memory preserves text and provenance without promoting import candidates', () => {
  const text = '原始内容\n---\n## 仍是内容';
  const record = decodeLegacyMemory(markdown(memory, text), id);
  const { schema, shareWithOnlineModel, ...fields } = memory;
  assert.deepEqual(record, { ...fields, sourceSchema: schema, text, recordedShareWithOnlineModel: shareWithOnlineModel });
});

test('legacy confirmed fallback timestamps retain the original revision and ID', () => {
  const record = decodeLegacyMemory(markdown({ schema: 1, id, kind: '事实', createdAt: time, source: '手工', status: 'confirmed', shareWithOnlineModel: false }, '事实正文'), id);
  assert.equal(record.updatedAt, time); assert.equal(record.confirmedAt, time); assert.equal(record.revision, 1);
  assert.equal(record.id, id); assert.equal(record.citation, ''); assert.equal(record.version, '');
});

test('legacy goal is a record with stable steps, independent status and no implicit consent', () => {
  const record = decodeLegacyGoal(markdown({ ...goal, schema: 1, shareWithOnlineModel: undefined }, `# 整理资料\n\n## 说明\n供用户决定\n\n## 步骤\n- [x] 1. 阅读 <!-- ${stepID} -->`), id);
  assert.deepEqual(record, { sourceSchema: 1, id, title: '整理资料', createdAt: time, status: '已暂停', details: '供用户决定', recordedShareWithOnlineModel: false, steps: [{ id: stepID, text: '阅读', isComplete: true }] });
});

test('bad document, unknown versions, IDs, dates and structural ambiguity fail closed', () => {
  const invalid = { message: 'invalid_legacy_document' };
  for (const bytes of [new Uint8Array(65_537), Uint8Array.of(0xff), Buffer.from('---\n{}'), markdown({ ...identity, schema: 3 }, '# Name'), markdown({ ...identity, createdAt: '2026-02-30T00:00:00Z' }, '# Name'), markdown(identity, '# Name\n## 边界\nfirst\n## 边界\nsecond')]) {
    assert.throws(() => decodeLegacyIdentity(bytes, clock), invalid);
  }
  for (const bytes of [markdown({ ...memory, schema: 5 }, 'text'), markdown({ ...memory, id: stepID }, 'text'), markdown({ ...memory, revision: 0 }, 'text'), markdown({ ...memory, status: 'unknown' }, 'text'), markdown(memory, '宠'.repeat(1001))]) {
    assert.throws(() => decodeLegacyMemory(bytes, id), invalid);
  }
  const duplicate = `# 标题\n\n## 步骤\n- [x] 1. 第一条 <!-- ${stepID} -->\n- [ ] 2. 第二条 <!-- ${stepID} -->`;
  for (const body of [duplicate, '# 标题\n## 步骤\n- [x] 无步骤 ID']) assert.throws(() => decodeLegacyGoal(markdown(goal, body), id), invalid);
});


test('the same tracked Longmei examples used by the Swift store load in the TypeScript decoder', async () => {
  const base = new URL('../../../docs/examples/龙妹角色资料/', import.meta.url);
  const [persona, note, plan] = await Promise.all(['identity.md', 'memories/示例-角色约定.md', 'plans/示例-建立可信赖的角色记忆.md'].map(path => readFile(new URL(path, base))));
  const identity = decodeLegacyIdentity(persona!, clock);
  assert.equal(identity.name, '龙妹'); assert.notEqual(identity.role, ''); assert.notEqual(identity.values, '');
  const memory = decodeLegacyMemory(note!, 'a31ed427-88fc-4a49-b0bc-0b71a7311d2c');
  assert.equal(memory.status, 'candidate'); assert.equal(memory.recordedShareWithOnlineModel, false);
  const goal = decodeLegacyGoal(plan!, '9f0ca44a-78bc-4bcf-bf7b-63cbcfd0ab16');
  assert.equal(goal.status, '进行中'); assert.equal(goal.steps.length, 4); assert.ok(goal.steps.every(step => !step.isComplete));
});
