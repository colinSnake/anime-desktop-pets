import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Goal, Memory, RecordSnapshot } from '../../../packages/contracts/src/character-records.ts';
import { emptyIdentity } from '../src/pages/identity-editor.ts';
import { PetAgentPanel } from '../src/pages/CharacterDataDialog.tsx';
import { summarizePetAgent } from '../src/pages/pet-agent-overview.ts';

const chat = { localAvailable: true, online: true, available: true };
const dates = { createdAt: '2026-11-19T00:00:00.000Z', updatedAt: '2026-11-19T00:00:00.000Z' };
const petID = 'synthetic-pet';
const identity = { snapshot: { schemaVersion: 1 as const, petID, identity: null, identityHistory: [], revision: 0 } };
const records = <T extends Goal | Memory>(...records: T[]): { snapshot: RecordSnapshot<T> } => ({ snapshot: { schemaVersion: 1, petID, records, revision: 1 } });
const goal: Goal = { id: 'synthetic-goal', revision: 1, title: '读书笔记', details: '不应出现在总览的说明', status: '进行中', ...dates,
  steps: [{ id: 'a', text: '摘录', isComplete: true }, { id: 'b', text: '复查', isComplete: false }] };
const candidate: Memory = { id: 'synthetic-memory', revision: 1, kind: '偏好', text: '不公开待审核正文', source: '', citation: '', version: '', status: 'candidate', ...dates };

test('Agent overview is a single dialog with four ordinary detail buttons and no role tabs', () => {
  const html = renderToStaticMarkup(createElement(PetAgentPanel, { name: '合成实例', chat, onClose() {}, renderDetail: () => assert.fail('no detail on open') }));
  assert.match(html, /<dialog[^>]*>[\s\S]*?<h2[^>]*>桌宠 Agent<\/h2>/);
  assert.deepEqual([...html.matchAll(/data-agent-section="([^"]+)"/g)].map(match => match[1]), ['identity', 'memory', 'goals', 'capabilities']);
  assert.doesNotMatch(html, /role="tab|待你确认|资料仅本机/);
});

test('Agent close control is an icon button with a screen reader label', () => {
  const html = renderToStaticMarkup(createElement(PetAgentPanel, { name: '合成实例', chat, onClose() {}, renderDetail: () => null }));
  assert.match(html, /<button[^>]*class="dialog-close"[^>]*aria-label="关闭桌宠 Agent"[^>]*><svg[^>]*aria-hidden="true"[^>]*><path[^>]*><\/path><\/svg><\/button>/);
});

test('overview distinguishes loading, unavailable, confirmed empty and stale failed reads', () => {
  const loading = summarizePetAgent({}, {}, {}, chat);
  assert.equal(loading.rows.identity, '正在读取…');
  assert.equal(loading.rows.memory, '正在读取…');
  assert.equal(loading.privacy, '正在核对资料授权…');
  const empty = summarizePetAgent(identity, records(), records(), chat);
  assert.equal(empty.rows.identity, '尚未保存身份');
  assert.equal(empty.rows.memory, '暂无记忆或角色知识');
  assert.equal(empty.rows.goals, '暂无目标');
  assert.equal(empty.privacy, '资料仅本机');
  assert.equal(empty.pending, undefined);
  const failed = summarizePetAgent(identity, { ...records(candidate), error: 'unavailable', needsRead: true }, records(), chat);
  assert.equal(failed.rows.memory, '读取失败');
  assert.equal(failed.privacy, '资料授权状态未确认');
  assert.equal(failed.pending, undefined);
  assert.equal(summarizePetAgent(undefined, undefined, undefined, chat).rows.identity, '资料服务未连接');
});

test('overview shows saved step counts and real review and sharing states without exposing record bodies', () => {
  const shared = { snapshot: { ...identity.snapshot, identity: { ...emptyIdentity, name: '合成身份', revision: 1, chatShare: true as const, ...dates } } };
  const summary = summarizePetAgent(shared, records({ ...candidate, kind: '知识' }), records(goal), chat);
  assert.equal(summary.rows.identity, '合成身份');
  assert.equal(summary.rows.goals, '读书笔记 · 1 / 2 步');
  assert.deepEqual(summary.pending, { count: 1, memoryMode: 'knowledge' });
  assert.equal(summary.privacy, '已有资料获在线聊天授权');
  assert.deepEqual(summary.capabilities, ['本机查询', '在线文字聊天']);
  assert.doesNotMatch(JSON.stringify(summary), /不公开待审核正文|不应出现在总览的说明/);
  const offline = summarizePetAgent(identity, records(), records(), { ...chat, available: false });
  assert.deepEqual(offline.capabilities, ['本机查询']);
});
