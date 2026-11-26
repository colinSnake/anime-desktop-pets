import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PetNookIcon } from '../src/PetNookIcon.tsx';
import { SpeechPreviewControls } from '../src/pages/SpeechPage.tsx';

const noCall = () => assert.fail('render must never trigger playback or IPC');
const render = (state: Parameters<typeof SpeechPreviewControls>[0]['speech'], connected = true, busy = false, unconfirmed = false, previewAction?: 'preview' | 'stopPreview') =>
  renderToStaticMarkup(createElement(SpeechPreviewControls, { speech: state, connected, busy, unconfirmed, previewAction, onPreview: noCall, onStop: noCall }));
const button = (html: string, label: string) => {
  const match = [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].find(([body]) => body.includes(label));
  assert.ok(match, label); return match[0];
};

test('HMR with an older service asks for a restart instead of sending preview to a missing IPC handler', () => {
  const old = render({ state: 'enabled', hasReference: true });
  assert.match(button(old, '试听一句'), /disabled/);
  assert.match(old, /退出后重开应用/);
});

test('preview controls need a confirmed enabled session and never start on render', () => {
  for (const speech of [undefined, { state: 'disabled', hasReference: true }, { state: 'unavailable', hasReference: false }, { state: 'loading', hasReference: true }] as const)
    assert.match(button(render(speech), '试听一句'), /disabled/);
  const ready = { state: 'enabled', hasReference: true, previewAvailable: true } as const;
  assert.doesNotMatch(button(render(ready), '试听一句'), /disabled/);
  for (const html of [render(ready, false), render(ready, true, true), render(ready, true, false, true)])
    assert.match(button(html, '试听一句'), /disabled/);
  assert.doesNotMatch(render(ready), /本机试听|停止试听|停止播放|退出后重开应用/);
});

test('the preview toggle stays stoppable while starting, and is disabled while stopping', () => {
  const ready = { state: 'enabled', hasReference: true, previewAvailable: true } as const;
  const starting = render(ready, true, true, false, 'preview');
  assert.doesNotMatch(button(starting, '停止播放'), /disabled/);
  assert.doesNotMatch(starting, /试听一句/);
  const stopping = render(ready, true, true, false, 'stopPreview');
  assert.match(button(stopping, '停止播放'), /disabled/);
  assert.doesNotMatch(stopping, /试听一句/);
});

test('only the preview source switches the toggle to stop', () => {
  for (const state of ['loading', 'speaking'] as const) {
    const bubble = { state, hasReference: true, previewAvailable: true } as const;
    assert.match(button(render(bubble), '试听一句'), /disabled/);
    assert.doesNotMatch(render(bubble), /停止播放/);
    const preview = render({ ...bubble, previewing: true });
    assert.doesNotMatch(button(preview, '停止播放'), /disabled/);
    assert.doesNotMatch(preview, /试听一句|停止试听/);
  }
});

test('the preview toggle icon follows its action', () => {
  const ready = { state: 'enabled', hasReference: true, previewAvailable: true } as const;
  const audioIcon = renderToStaticMarkup(createElement(PetNookIcon, { name: 'audio' }));
  const stopIcon = renderToStaticMarkup(createElement(PetNookIcon, { name: 'stop' }));
  assert.ok(button(render(ready), '试听一句').includes(audioIcon));
  for (const html of [render(ready, true, true, false, 'preview'),
    render({ ...ready, state: 'speaking', previewing: true }), render(ready, true, true, false, 'stopPreview')]) {
    const stop = button(html, '停止播放');
    assert.ok(stop.includes(stopIcon), '停止播放应显示方形停止图标');
    assert.ok(!stop.includes(audioIcon));
  }
});

test('the status distinguishes enabled, warming, ready, and failed preload without blocking a valid request', async () => {
  const { BubbleSpeechStatus } = await import('../src/pages/SpeechPage.tsx');
  const enabled = { state: 'enabled', hasReference: true, previewAvailable: true } as const;
  for (const [runtime, label, tone] of [
    ['cold', '模型待加载', 'warn'], ['preparing', '模型准备中', 'warn'],
    ['ready', '模型已就绪', 'good'], ['failed', '模型预载失败', 'bad'],
  ] as const) {
    const speech = { ...enabled, runtime };
    const html = renderToStaticMarkup(createElement(BubbleSpeechStatus, { speech, connected: true, busy: false, unconfirmed: false }));
    assert.ok(html.includes(`data-tone="${tone}">已启用 · ${label}`), html);
    assert.doesNotMatch(button(render(speech), '试听一句'), /disabled/);
  }
});
