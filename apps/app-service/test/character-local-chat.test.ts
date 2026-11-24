import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLocalChatAnswer } from '../src/characters/local-chat.ts';
import type { CharacterState } from '../src/characters/records.ts';

const now = '2026-11-24T00:00:00.000Z';
const emptyState = (): CharacterState => ({ schemaVersion: 1, petID: 'pet-one', revision: 0, identity: null, identityHistory: [], memories: [], goals: [] });

test('local identity introduction uses a safe registered name without creating a persona', () => {
  const state = emptyState();
  const before = structuredClone(state);
  const answer = buildLocalChatAnswer({ intent: 'identity' }, state, now, '  合成伙伴  ');
  assert.match(answer, /^我是合成伙伴，你当前选择的桌宠。/);
  assert.match(answer, /尚未设置本机身份.*桌宠 Agent.*身份/s);
  assert.deepEqual(state, before);
});

test('local identity introduction omits missing and credential-like registered names', () => {
  for (const name of [undefined, '', '  ', '合成密码', 'API Key: synthetic-only', 'to\u200bken: synthetic-only']) {
    const answer = buildLocalChatAnswer({ intent: 'identity' }, emptyState(), now, name);
    assert.match(answer, /^我是你当前选择的桌宠。/);
    assert.match(answer, /尚未设置本机身份/);
    assert.doesNotMatch(answer, /synthetic-only|密码/);
  }
});

test('saved identity safety filters cannot be bypassed by the default pet introduction', () => {
  const state: CharacterState = { ...emptyState(), identity: { name: '合成密码', role: '', background: '', personality: '', values: '', motivations: '', relationship: '', speakingStyle: '', knowledgeScope: '', boundaries: '', revision: 1, createdAt: now, updatedAt: now } };
  assert.equal(buildLocalChatAnswer({ intent: 'identity' }, state, now, '合成伙伴'), '当前桌宠暂无可展示的本机身份。');
  state.identity!.name = '合成身份';
  state.identity!.role = 'token: synthetic-only';
  assert.equal(buildLocalChatAnswer({ intent: 'identity' }, state, now, '合成伙伴'), '当前桌宠暂无可展示的本机身份。');
});
