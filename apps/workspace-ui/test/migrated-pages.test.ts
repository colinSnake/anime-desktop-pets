import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkspaceView } from '../src/App.tsx';

const props = { busy: false, error: '', onRefresh() {}, onProbe() {}, onStartPlayer() {}, onStopPlayer() {} };
const view = (initialPage: NonNullable<Parameters<typeof WorkspaceView>[0]['initialPage']>) =>
  renderToStaticMarkup(createElement(WorkspaceView, { ...props, initialPage }));
const disabledButton = (html: string, label: string) =>
  assert.match(html, new RegExp(`<button[^>]*\\bdisabled=""[^>]*>${label}</button>`), label);

test('identity page has editable main fields, detailed settings, version history and no share authorization', () => {
  const html = view('identity');
  for (const text of ['名称', '性格', '表达方式', '与你的关系', '基础设定', '版本历史', '表达适应', '仅保留在当前窗口']) assert.ok(html.includes(text), text);
  assert.match(html, /<label[^>]*><span>名称<\/span><input[^>]*maxlength="80"/i);
  disabledButton(html, '保存身份');
  assert.doesNotMatch(html, /功能尚未迁移/);
});

test('memory keeps personal and knowledge drafting separate from persisted review and import', () => {
  const html = view('memory');
  for (const text of ['个人记忆', '角色知识', '待确认', '已确认', '来源', '引用或位置', '版本或日期', '有效期', '自动审核']) assert.ok(html.includes(text), text);
  assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*>个人记忆/);
  assert.equal([...html.matchAll(/disabled=""[^>]*>加入待确认<\/button>/g)].length, 2);
  disabledButton(html, '选择文本文件');
  assert.doesNotMatch(html, /type="file"|功能尚未迁移/);
});

test('capabilities and goals expose separate views and a draft that does not run jobs', () => {
  const html = view('goals');
  for (const text of ['可用能力', '目标计划', '添加步骤', '不会触发后台执行', '任务跟随']) assert.ok(html.includes(text), text);
  disabledButton(html, '保存目标');
  assert.doesNotMatch(html, /功能尚未迁移/);
});

test('speech and live pages represent old controls without devices, authorizations or fake connections', () => {
  const speech = view('speech'), live = view('live');
  for (const text of ['麦克风', '参考音频', '准确转写', '朗读生成的回复', '朗读桌宠互动气泡', 'AI 生成日常陪伴气泡']) assert.ok(speech.includes(text), text);
  assert.match(speech, /<label[^>]*><span>参考音频的准确转写<\/span><textarea[^>]*maxlength="4096"/i);
  for (const action of ['选择麦克风', '检测麦克风', '选择参考音频', '移除参考音频', '开始语音聊天', '运行在线模型演示', '保存语音设置']) disabledButton(speech, action);
  for (const text of ['房间配置', 'B 站', '抖音', '直播间号或房间标识', '弹幕与互动']) assert.ok(live.includes(text), text);
  disabledButton(live, '保存直播设置');
  disabledButton(live, '连接直播间');
  assert.doesNotMatch(speech + live, /type="file"|type="password"|功能尚未迁移/);
});

test('advanced retains truthful existing diagnostics and adds restricted system actions', () => {
  const html = view('advanced');
  for (const text of ['本机数据', '系统权限', '运行诊断', '开发桌宠 · 显式启停', '平台能力边界']) assert.ok(html.includes(text), text);
  for (const action of ['打开数据文件夹', '查看辅助功能设置', '选择迁移快照']) disabledButton(html, action);
  assert.match(html, /<button[^>]*>刷新状态<\/button>/);
});

test('connected identity uses the selected new instance with a read-only loading state', () => {
  const notCalled = async () => assert.fail('SSR must not start service requests');
  const characters = { readIdentity: notCalled, saveIdentity: notCalled, restoreIdentity: notCalled, setIdentityChatShare: notCalled,
    readMemories: notCalled, searchKnowledge: notCalled, localChatContext: notCalled, addKnowledgeBatch: notCalled, selectKnowledgeFile: notCalled, readMemoryHistory: notCalled, editMemory: notCalled, restoreMemory: notCalled, addMemory: notCalled, confirmMemory: notCalled, withdrawMemory: notCalled, deleteMemory: notCalled, setMemoryChatShare: notCalled,
    readGoals: notCalled, addGoal: notCalled, editGoal: notCalled, deleteGoal: notCalled, setGoalChatShare: notCalled };
  const workspace = { revision: 1, maximumRunning: 3, catalog: [], linkage: 'active', theme: 'system', instances: [
    { id: 'synthetic-other', package: { id: 'local.pet', version: '1' }, displayName: '未选实例', enabled: true, autoStartOnLaunch: false, phase: 'stopped', preferences: { size: 256, hideInFullscreen: true, scheduledActivity: false, movement: false } },
    { id: 'synthetic-selected', package: { id: 'local.pet', version: '1' }, displayName: '当前测试实例', enabled: true, autoStartOnLaunch: false, phase: 'stopped', preferences: { size: 256, hideInFullscreen: true, scheduledActivity: false, movement: false } },
  ] } as const;
  const html = renderToStaticMarkup(createElement(WorkspaceView, { ...props, initialPage: 'identity', characters,
    petState: { workspace: { ...workspace, catalog: [], instances: [...workspace.instances] }, selectedId: 'synthetic-selected', drafts: {}, notice: '', needsRefresh: false } }));
  assert.match(html, /当前测试实例/);
  assert.match(html, /正在读取身份资料/);
  assert.match(html, /readonly=""/i);
  assert.doesNotMatch(html, /未选实例|界面预览/);
  disabledButton(html, '保存身份');
});
