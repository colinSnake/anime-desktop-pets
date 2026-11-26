import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptionSchedule, parseVideoLines } from '../src/video-preview/captions.ts';
import { videoCue } from '../../app-service/src/workspace-video-protocol.ts';

test('caption only offers the current visible acknowledgement once; clear, timeout and replacement revoke it', () => {
  const states: unknown[] = [], offers: unknown[] = [];
  const captions = new CaptionSchedule(value => states.push(value), (value, token) => offers.push([value, token]));
  const a = captions.show('task', '正在陪你工作。', 0)!;
  assert.equal(captions.confirm(a, false, 1), false);
  assert.equal(captions.confirm(a + 1, true, 1), false);
  assert.equal(captions.confirm(a, true, 1), true);
  assert.equal(captions.confirm(a, true, 2), false);
  const b = captions.show('interaction', '你好呀！', 3)!;
  assert.equal(captions.confirm(a, true, 4), false);
  assert.equal(captions.confirm(b, true, 30_004), false);
  assert.equal(captions.expire(30_004), true);
  const c = captions.show('greeting', '休息一下。', 31_000)!;
  captions.clear();
  assert.equal(captions.confirm(c, true, 31_050), false);
  assert.deepEqual(offers, [['正在陪你工作。', a], [undefined, a]]);
  assert.equal(states.at(-1), undefined);
});

test('only audited clip keys and bounded texts enter the caption table and speech event', () => {
  const text = '试验台词。';
  assert.equal(parseVideoLines({ '01': text })?.['01'], text);
  assert.equal(parseVideoLines({ '01': 'a\nb' }), undefined);
  assert.equal(parseVideoLines({ 'idle': text }), undefined);
  assert.equal(parseVideoLines({ 'work01': 'wrong alias' }), undefined);
  assert.equal(parseVideoLines({ 'work': text })?.work, text);
  const event = { type: 'workspace-video-cue', version: 1, id: 'pet-1', seq: 2, cue: 1, text };
  assert.equal(videoCue(event), true);
  assert.equal(videoCue({ ...event, text: null }), true);
  assert.equal(videoCue({ ...event, text: 'a\n' }), false);
  assert.equal(videoCue({ ...event, path: '/ignored' }), false);
  assert.equal(videoCue({ ...event, cue: Infinity }), false);
});


test('accepted speech survives the text TTL; only a matching drain gets a short tail', () => {
  const revoked: number[] = [];
  const captions = new CaptionSchedule(() => {}, (text, token) => { if (!text) revoked.push(token); });
  const a = captions.show('task', '短工作气泡', 0)!;
  assert.equal(captions.speech(a, 'held', 1), false); // Not yet painted.
  assert.equal(captions.confirm(a, true, 2), true);
  assert.equal(captions.speech(a, 'held', 3), true);
  assert.equal(captions.speech(a + 1, 'drained', 10_000), false);
  assert.equal(captions.expire(10_000), false);
  assert.deepEqual(revoked, []);
  assert.equal(captions.speech(a, 'drained', 10_000), true);
  assert.equal(captions.speech(a, 'held', 10_100), false);
  assert.equal(captions.expire(10_699), false);
  assert.equal(captions.expire(10_700), true);
  assert.deepEqual(revoked, [a]);

  const b = captions.show('interaction', '只保留原阅读时长', 20_000)!;
  captions.confirm(b, true, 20_001);
  assert.equal(captions.speech(a, 'held', 20_002), false);
  captions.speech(b, 'held', 20_002);
  assert.equal(captions.speech(b, 'released', 20_003), true);
  assert.equal(captions.expire(23_999), false);
  assert.equal(captions.expire(24_000), true);

  const c = captions.show('greeting', '失联兜底', 30_000)!;
  captions.confirm(c, true, 30_001);
  captions.speech(c, 'held', 30_002);
  assert.equal(captions.expire(400_002), true);
  assert.deepEqual(revoked, [a, b, c]);
});
