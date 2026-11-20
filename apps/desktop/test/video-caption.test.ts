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
