import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixtureAdmission, validTextEvents } from './lib/pet-sdk-probe-admission.mjs';

const binding = { petID: 'fixture-pet', requestID: 'fixture-turn', model: 'pet-fixture', revision: 7, text: '合成正文' };
const body = { model: binding.model, messages: [{ role: 'user', content: binding.text }], stream: true, store: false, max_completion_tokens: 96 };

test('only the bound text and model consume one active slot; foreign headers and tools cannot consume it', () => {
  const admission = createFixtureAdmission();
  const turn = admission.open(binding, () => 7);
  const header = `Bearer ${turn.capability}`;
  assert.equal(admission.open({ ...binding, requestID: 'concurrent' }, () => 7), undefined);
  assert.equal(turn.claim(`Bearer ${'0'.repeat(48)}`, body), 'forbidden');
  assert.equal(turn.claim(header, { ...body, model: 'changed-route' }), 'invalid');
  assert.equal(turn.claim(header, { ...body, messages: [{ role: 'user', content: '另一个实例的回合' }] }), 'invalid');
  assert.equal(turn.claim(header, { ...body, tools: [{ name: 'unsafe' }] }), 'invalid');
  assert.equal(turn.claim(header, { ...body, dsh_session_log: {} }), 'invalid');
  assert.equal(turn.claim(header, { ...body, store: true }), 'invalid');
  assert.equal(turn.claim(header, { ...body, stream_options: { include_usage: true, unknown: 'not admitted' } }), 'invalid');
  assert.equal(turn.claim(header, { ...body, messages: [...body.messages, ...body.messages] }), 'invalid');
  assert.equal(turn.claim(header, { ...body, messages: [...body.messages, { role: 'assistant', content: 'untrusted' }] }), 'invalid');
  assert.equal(turn.claim(header, { ...body, stream_options: { include_usage: true } }), 'admitted');
  assert.equal(turn.claim(header, body), 'used');
  turn.close();
  assert.equal(turn.claim(header, body), 'forbidden');
  assert.equal(admission.open(binding, () => 7), undefined);
  const next = admission.open({ ...binding, requestID: 'new-turn' }, () => 7);
  assert.notEqual(next.capability, turn.capability);
  assert.equal(next.claim(header, body), 'forbidden');
});

test('checks the immutable revision again immediately before dispatch', () => {
  let revision = 7;
  const input = { ...binding };
  const turn = createFixtureAdmission().open(input, () => revision);
  input.revision = 8; revision = 8;
  assert.equal(turn.claim(`Bearer ${turn.capability}`, body), 'stale');
  assert.equal(turn.claim(`Bearer ${turn.capability}`, body), 'forbidden');
});

test('a terminal model result requires ordered, bounded text events, not just an SDK return', () => {
  const events = ['turn/start', 'user/message', 'request/header', 'assistant/message', 'turn/end'].map((type, seq) => ({ type, seq }));
  assert.equal(validTextEvents(events), true);
  assert.equal(validTextEvents(events.slice(0, -1)), false);
  assert.equal(validTextEvents(events.map(row => row.seq === 2 ? { ...row, seq: 1 } : row)), false);
  assert.equal(validTextEvents(events.map(row => row.seq === 1 ? { ...row, type: 'tool/result' } : row)), false);
  assert.equal(validTextEvents([...events, { type: 'turn/end', seq: 5 }]), false);
});
