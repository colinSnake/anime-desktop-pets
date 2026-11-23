import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement as h } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { WorkspaceView } from '../src/App.tsx';
import { FullPermissionDialog } from '../src/AgentTaskPanel.tsx';
import { ChatHistoryDialog } from '../src/ChatHistoryDialog.tsx';
import { ModelDialog } from '../src/ModelDialog.tsx';
import { SettingsDialog } from '../src/SettingsDialog.tsx';
import { emptyPetState } from '../src/pet-state.ts';

const noop = () => {};
const unavailable = async () => ({ ok: false, error: 'unavailable' } as const);
const closeIcon = /<button[^>]*class="dialog-close"[^>]*aria-label="关闭[^"\n]*"[^>]*><svg[^>]*aria-hidden="true"[^>]*><path d="m6 6 12 12M18 6 6 18"/;

test('full permission confirmation does not claim broader access than the current read-only agent', () => {
 const html = render(h(FullPermissionDialog, { open: true, onCancel: noop, onConfirm: noop }));
 assert.match(html, /确认使用“完全允许”/);
 assert.doesNotMatch(html, /允许完全访问/);
});

test('workspace dialogs reuse an accessible icon-only close control', () => {
  const fixtures = [
    h(SettingsDialog, { title: '桌宠设置', busy: false, onClose: noop, children: '合成表单' }),
    h(ModelDialog, { title: '添加连接', onClose: noop, children: '合成表单', footer: null }),
    h(ChatHistoryDialog, { petID: 'synthetic-pet', name: '龙妹', pending: false, reading: false, onRead: noop, onCleared: noop, onClose: noop,
      bridge: { list: unavailable, detail: unavailable, clear: unavailable } }),
    h(FullPermissionDialog, { open: true, onCancel: noop, onConfirm: noop }),
    h(WorkspaceView, { petState: { ...emptyPetState, deleteId: 'synthetic-pet' }, busy: false, error: '', onRefresh: noop, onProbe: noop }),
  ];
  for (const fixture of fixtures) assert.match(render(fixture), closeIcon);
});

test('saving still disables the close control for pet settings and model writes', () => {
  for (const fixture of [
    h(SettingsDialog, { title: '桌宠设置', busy: true, onClose: noop, children: null }),
    h(ModelDialog, { title: '编辑连接', locked: true, onClose: noop, children: null, footer: null }),
  ]) {
    const html = render(fixture);
    assert.match(html, closeIcon);
    assert.match(html, /<button[^>]*class="dialog-close"[^>]*disabled=""/);
  }
});
