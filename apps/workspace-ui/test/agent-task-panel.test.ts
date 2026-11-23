import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentTaskPanel, AgentTaskRows, taskCreateWasAccepted } from '../src/AgentTaskPanel.tsx';
import type { AgentTaskCreate, AgentTaskSnapshot } from '../../../packages/contracts/src/agent-tasks.ts';

const unavailable = async () => ({ ok: false as const, error: 'unavailable' as const });
const model = { id: 'scope', name: '合成模型', taskRoute: { connectionID: 'a', modelEntryID: 'a', fingerprint: 'a'.repeat(64) } };
const task = { petID: 'pet-one', taskID: '1f000000-0000-4000-8000-000000000001', attemptID: '1f000000-0000-4000-8000-000000000002', revision: 3 };


test('task attachments clear only after a verified create acknowledgement', () => {
 const input: AgentTaskCreate = { petID: 'pet-one', taskID: task.taskID, route: { ...model.taskRoute }, prompt: '整理材料', files: [{ name: 'notes.txt', mediaType: 'text/plain', data: '5L2g5aW9' }] };
 assert.equal(taskCreateWasAccepted(input, { ok: false, error: 'unavailable' }), false);
 assert.equal(taskCreateWasAccepted(input, { ok: true, task: { ...task, status: 'queued', phase: 'admitting', progress: 0 } }), true);
});

test('task panel shows explicit separate prompt, model and text-file selection with a read-only disclosure', () => {
 const html = renderToStaticMarkup(createElement(AgentTaskPanel, { petID: 'pet-one', name: '龙妹', models: [model], opener: undefined, onClose: () => {},
  bridge: { create: unavailable, list: unavailable, read: unavailable, cancel: unavailable } }));
 assert.match(html, /龙妹/); assert.match(html, /选择模型/); assert.match(html, /只读/); assert.match(html, /type="file"/);
 assert.match(html, /<button[^>]+disabled=""[^>]*>开始任务/); assert.doesNotMatch(html, /应用变更/);
});

test('task panel has a named close icon and accessible drop zone without the removed model settings', () => {
 const html = renderToStaticMarkup(createElement(AgentTaskPanel, { petID: 'pet-one', name: '龙妹', models: [{ ...model, taskToolsUnverified: true }], onClose() {},
  bridge: { create: unavailable, list: unavailable, read: unavailable, cancel: unavailable } }));
 assert.match(html, /aria-label="关闭弹窗"[^>]*><svg/);
 assert.match(html, /<button[^>]+aria-describedby="agent-task-file-limits"[^>]*>/);
 assert.match(html, /拖拽文件到这里/);
 assert.match(html, /执行权限/);
 assert.match(html, /请求批准/);
 assert.match(html, /完全允许/);
 assert.match(html, /合成模型 · 待验证/);
 assert.doesNotMatch(html, /模型管理 → 模型参数/);
});

test('review escapes provider text and labels unknown outcomes without any replay or apply control', () => {
 const tasks: AgentTaskSnapshot[] = [
  { ...task, status: 'completed', phase: 'review', progress: 100, result: '<script>仅文本</script>' },
  { ...task, taskID: '1f000000-0000-4000-8000-000000000003', status: 'outcome-unknown', phase: 'thinking', progress: 20 },
 ];
 const html = renderToStaticMarkup(createElement(AgentTaskRows, { tasks, busy: false, onCancel: () => {} }));
 assert.match(html, /&lt;script&gt;仅文本&lt;\/script&gt;/); assert.match(html, /结果未确认/);
 assert.doesNotMatch(html, /<script>|应用变更|重新运行/);
});
