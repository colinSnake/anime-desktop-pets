import assert from 'node:assert/strict';
import test from 'node:test';
import type { Memory } from '../../../packages/contracts/src/character-records.ts';
import { recallKnowledge } from '../src/characters/knowledge-recall.ts';

const now = '2026-11-18T12:00:00.000Z';
const createdAt = '2026-09-01T00:00:00.000Z';
const knowledge = (n: number, overrides: Partial<Memory>): Memory => ({ kind: '知识', id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
  revision: 1, text: '合成正文', source: '合成手册', citation: '', version: '', createdAt, updatedAt: createdAt,
  status: 'confirmed', confirmedAt: createdAt, ...overrides } as Memory);

test('local recall uses body and evidence, ranks exact phrase above partial tokens, and has stable capped ordering', () => {
  const newer = '2026-10-01T00:00:00.000Z';
  const partial = knowledge(1, { text: '星图放在北窗', createdAt: now });
  const evidence = knowledge(4, { citation: '第 2 章：星图索引', version: 'Atlas V2 edition', createdAt: newer });
  const first = knowledge(2, { text: '星图索引的第一页', createdAt: newer });
  const older = knowledge(3, { text: '星图索引存放地点' });
  assert.deepEqual(recallKnowledge('星图·索引', [partial, evidence, first, older], now), [first.id, evidence.id, older.id]);
  assert.deepEqual(recallKnowledge('ａｔｌａｓ', [partial, evidence], now), [evidence.id]);
  assert.deepEqual(recallKnowledge('atlas missing', [partial, evidence], now), [evidence.id]);
  assert.deepEqual(recallKnowledge('并不相关', [partial, evidence], now), []);
  assert.deepEqual(recallKnowledge('。', [partial, evidence], now), []);
});

test('local recall filters pending, personal, expired, credentials, and unresolved evidence before ranking', () => {
  const records = [
    knowledge(1, { text: '星图来源正文甲', citation: '星图条目', version: '1' }),
    knowledge(2, { text: '星图来源正文乙', citation: '星图条目', version: '1' }),
    knowledge(3, { status: 'candidate', confirmedAt: undefined, text: '星图候选' }),
    knowledge(4, { kind: '事实', text: '星图私人记忆' }),
    knowledge(5, { text: '星图过期', expiresAt: now }),
    knowledge(6, { text: '星图', source: '合成密钥' }),
    knowledge(7, { text: '星图可用正文', citation: '条目七' }),
    knowledge(8, { text: '星图过去的不同内容', citation: '条目七', expiresAt: now }),
  ];
  assert.deepEqual(recallKnowledge('星图', records, now), [records[6]!.id]);
});
