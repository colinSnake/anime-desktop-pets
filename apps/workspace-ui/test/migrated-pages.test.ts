import { renderWorkspace } from './render-workspace.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { WorkspaceView } from '../src/App.tsx';

const props = { busy: false, error: '', onRefresh() {}, onProbe() {}, onStartPlayer() {}, onStopPlayer() {} };
const view = (initialPage: NonNullable<Parameters<typeof WorkspaceView>[0]['initialPage']>) =>
  renderWorkspace(createElement(WorkspaceView, { ...props, initialPage }));
const disabledButton = (html: string, label: string) =>
  assert.match(html, new RegExp(`<button[^>]*\\bdisabled=""[^>]*>${label}</button>`), label);

test('identity page has editable main fields, detailed settings, version history and no share authorization', async () => {
  const html = await view('identity');
  for (const text of ['名称', '性格', '表达方式', '与你的关系', '基础设定', '版本历史', '仅保留在当前窗口']) assert.ok(html.includes(text), text);
  assert.match(html, /<label[^>]*><span>名称<\/span><input[^>]*maxlength="80"/i);
  disabledButton(html, '保存身份');
  assert.doesNotMatch(html, /功能尚未迁移/);
});

test('memory keeps personal and knowledge drafting separate from persisted review and import', async () => {
  const html = await view('memory');
  for (const text of ['个人记忆', '角色知识', '待确认', '已确认', '来源', '引用或位置', '版本或日期', '有效期', '在线聊天授权需逐条开启']) assert.ok(html.includes(text), text);
  assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*>个人记忆/);
  assert.equal([...html.matchAll(/disabled=""[^>]*>加入待确认<\/button>/g)].length, 2);
  disabledButton(html, '选择文本文件');
  assert.doesNotMatch(html, /type="file"|功能尚未迁移/);
});

test('capabilities and goals expose separate views and a draft that does not run jobs', async () => {
  const html = await view('goals');
  for (const text of ['可用能力', '目标计划', '添加步骤', '不会触发后台执行', '功能与授权范围']) assert.ok(html.includes(text), text);
  disabledButton(html, '保存目标');
  assert.doesNotMatch(html, /功能尚未迁移/);
});

test('speech matches the reference setup flow without enabling playback on render', async () => {
  const html = await view('speech');
  const page = html.slice(html.indexOf('<main'));
  assert.match(page, /<header class="interaction-heading">[\s\S]*?<h1>语音互动<\/h1>[\s\S]*?class="theme-toggle"/);
  assert.match(page, /气泡播报[\s\S]*?设置参考音色[\s\S]*?参考音频[\s\S]*?音频逐字稿[\s\S]*?启用气泡播报[\s\S]*?隐私与功能范围/);
  assert.match(page, /<img[^>]*src="pet-app:[^"]*longmei[^"]*"[^>]*draggable="false"/);
  assert.match(page, /<label for="speech-transcript">[\s\S]*?音频逐字稿<\/label>/);
  assert.match(page, /<textarea[^>]*id="speech-transcript"[^>]*maxlength="4096"/i);
  assert.match(page, /<output[^>]*for="speech-transcript"[^>]*>0 \/ 4096 字节<\/output>/);
  for (const action of ['选择参考音频', '启用气泡播报'])
    assert.ok([...page.matchAll(/<button[^>]*disabled=""[^>]*>([\s\S]*?)<\/button>/g)].some(([, body]) => body!.replace(/<[^>]*>/g, '') === action), action);
  assert.match(page, /<details[^>]*><summary>[\s\S]*?隐私与功能范围[\s\S]*?<\/summary>/);
  assert.doesNotMatch(page, /type="file"|选择麦克风|试听|预览状态/);
});

test('live exposes the two local drafts and only informational platform capabilities', async () => {
  const html = await view('live');
  const page = html.slice(html.indexOf('<main'));
  assert.match(page, /<header class="interaction-heading">[\s\S]*?<h1>直播管理<\/h1>[\s\S]*?class="theme-toggle"/);
  assert.match(page, /平台尚未接入[\s\S]*?仅支持草稿[\s\S]*?房间草稿[\s\S]*?平台能力/);
  assert.match(page, /<img[^>]*src="pet-app:[^"]*dafeiyu[^"]*"[^>]*draggable="false"/);
  assert.equal((page.match(/type="radio"/g) ?? []).length, 2);
  for (const text of ['B 站', '抖音', '直播间号或房间标识', '当前平台还没有填写内容']) assert.ok(page.includes(text), text);
  for (const text of ['平台授权', '连接直播间', '收发弹幕']) assert.match(page, new RegExp(`<li><span>[\\s\\S]*?${text}</span><span[^>]*>未接入</span></li>`));
  assert.equal((page.match(/<button\b/g) ?? []).length, 1, 'empty live page has just the shared appearance button');
  assert.doesNotMatch(page, /<form|type="password"|type="file"|预览状态/);
});

const buttonWithText = (html: string, label: string) => {
  const found = [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].find(([, body]) => body!.replace(/<[^>]*>/g, '') === label);
  assert.ok(found, label);
  return found[0];
};

test('advanced keeps the approved workbench and only one concise opt-in diagnostic tool', async () => {
  const html = await view('advanced');
  const page = html.slice(html.indexOf('<main'));
  const advancedNav = buttonWithText(html, '高级');
  assert.match(advancedNav, /<path d="M14 17H5"/);
  assert.match(advancedNav, /<circle cx="17" cy="17" r="3"/);
  assert.match(advancedNav, /<circle cx="7" cy="7" r="3"/);
  assert.match(page, /<header class="interaction-heading">[\s\S]*?<h1>高级<\/h1>[\s\S]*?class="theme-toggle"/);
  assert.match(page, /本机数据[\s\S]*?工作区数据[\s\S]*?打开数据文件夹[\s\S]*?维护工具/);
  assert.match(buttonWithText(page, '打开数据文件夹'), /disabled=""/);
  assert.doesNotMatch(buttonWithText(page, '刷新状态'), /disabled=""/);
  assert.match(buttonWithText(page, '运行 Python 诊断'), /disabled=""/);
  const sections = [...page.matchAll(/<details[^>]*class="advanced-tool"[^>]*><summary>([\s\S]*?)<\/summary>/g)];
  assert.equal(sections.length, 1);
  assert.match(sections[0]![1]!, /运行诊断[\s\S]*宿主未连接/);
  for (const section of sections) assert.doesNotMatch(section[0].split('<summary>')[0]!, /\bopen=/);
  assert.match(page, /应用服务[\s\S]*?当前平台[\s\S]*?Python 桥接/);
  assert.doesNotMatch(page, /查看辅助功能设置|预览状态|旧角色资料交接|选择角色快照|确认导入|确认撤回|诊断范围|查看平台能力边界|回环监听|能力边界见下方|仅在手动点击后运行独立诊断/);
});

test('connected Advanced enables the scoped data folder action without opening it on render', async () => {
  const openWorkspaceData = async () => assert.fail('must wait for an explicit click');
  const html = await renderWorkspace(createElement(WorkspaceView, { ...props, initialPage: 'advanced', openWorkspaceData }));
  assert.doesNotMatch(buttonWithText(html, '打开数据文件夹'), /disabled=""/);
});

test('connected identity uses the selected new instance with a read-only loading state', async () => {
  const notCalled = async () => assert.fail('SSR must not start service requests');
  const characters = { readIdentity: notCalled, saveIdentity: notCalled, restoreIdentity: notCalled, setIdentityChatShare: notCalled,
    readMemories: notCalled, searchKnowledge: notCalled, localChatContext: notCalled, addKnowledgeBatch: notCalled, selectKnowledgeFile: notCalled, readMemoryHistory: notCalled, editMemory: notCalled, restoreMemory: notCalled, saveChatMemory: notCalled, addMemory: notCalled, confirmMemory: notCalled, withdrawMemory: notCalled, deleteMemory: notCalled, setMemoryChatShare: notCalled,
    readGoals: notCalled, addGoal: notCalled, editGoal: notCalled, deleteGoal: notCalled, setGoalChatShare: notCalled };
  const workspace = { revision: 1, maximumRunning: 3, catalog: [], linkage: 'active', theme: 'system', instances: [
    { id: 'synthetic-other', package: { id: 'local.pet', version: '1' }, displayName: '未选实例', enabled: true, autoStartOnLaunch: false, phase: 'stopped', preferences: { size: 256, hideInFullscreen: true, scheduledActivity: false, movement: false } },
    { id: 'synthetic-selected', package: { id: 'local.pet', version: '1' }, displayName: '当前测试实例', enabled: true, autoStartOnLaunch: false, phase: 'stopped', preferences: { size: 256, hideInFullscreen: true, scheduledActivity: false, movement: false } },
  ] } as const;
  const html = await renderWorkspace(createElement(WorkspaceView, { ...props, initialPage: 'identity', characters,
    petState: { workspace: { ...workspace, catalog: [], instances: [...workspace.instances] }, selectedId: 'synthetic-selected', drafts: {}, notice: '', needsRefresh: false } }));
  assert.match(html, /当前测试实例/);
  assert.match(html, /正在读取身份资料/);
  assert.match(html, /readonly=""/i);
  assert.doesNotMatch(html, /未选实例|界面预览/);
  disabledButton(html, '保存身份');
});
