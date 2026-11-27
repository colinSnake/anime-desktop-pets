import { renderWorkspace } from './render-workspace.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { WorkspaceView } from '../src/App.tsx';
import { LiveDanmaku } from '../src/pages/LiveDanmaku.tsx';

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
  for (const text of ['个人记忆', '角色知识', '待确认', '已确认', '来源', '引用或位置', '版本或日期', '有效期', '聊天和直播授权需分别开启']) assert.ok(html.includes(text), text);
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
  assert.match(page, /气泡播报[\s\S]*?设置参考音色[\s\S]*?参考音频[\s\S]*?音频逐字稿/);
  assert.match(page, /<img[^>]*src="pet-app:[^"]*longmei[^"]*"[^>]*draggable="false"/);
  assert.match(page, /<label for="speech-transcript">[\s\S]*?音频逐字稿<\/label>/);
  assert.match(page, /<textarea[^>]*id="speech-transcript"[^>]*maxlength="4096"/i);
  assert.match(page, /<output[^>]*for="speech-transcript"[^>]*>0 \/ 4096 字节<\/output>/);
  for (const action of ['选择参考音频', '试听一句', '启用气泡播报'])
    assert.ok([...page.matchAll(/<button[^>]*disabled=""[^>]*>([\s\S]*?)<\/button>/g)].some(([, body]) => body!.replace(/<[^>]*>/g, '') === action), action);
  assert.doesNotMatch(page, /播报新聊天回复|interaction-reply-option|type="checkbox"/);
  assert.doesNotMatch(page, /type="checkbox"[^>]*checked|type="file"|选择麦克风|预览状态/);
  const setup = page.slice(page.indexOf('aria-labelledby="speech-setup"'));
  const footer = setup.match(/<div class="interaction-card-footer">([\s\S]*?)<\/section>/)?.[1] ?? '';
  const labels = [...footer.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(([, body]) => body!.replace(/<[^>]*>/g, ''));
  assert.deepEqual(labels, ['试听一句', '启用气泡播报']);
  assert.doesNotMatch(page, /本机试听|停止试听|停止播放/);
  assert.doesNotMatch(page, /如何验证语音互动|隐私与功能范围|准备一段参考音频|准备后可试听|这是本机语音试听/);
});


test('speech transcript autosave coalesces edits and flushes the latest draft before leaving', async () => {
  const { createSpeechTranscriptSaver } = await import('../src/pages/speech-transcript-save.ts');
  const saved: string[] = [];
  const saver = createSpeechTranscriptSaver(async value => { saved.push(value); }, 60_000);
  saver.schedule('可');
  saver.schedule('可莉');
  await saver.flush();
  assert.deepEqual(saved, ['可莉']);
});

test('speech transcript flush waits for an active write and then persists the newest edit', async () => {
  const { createSpeechTranscriptSaver } = await import('../src/pages/speech-transcript-save.ts');
  const saved: string[] = [];
  let began!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const saver = createSpeechTranscriptSaver(async value => {
    if (value === '旧稿') { began(); await held; }
    saved.push(value);
  }, 60_000);
  saver.schedule('旧稿');
  const first = saver.flush();
  await started;
  saver.schedule('最新稿');
  const latest = saver.flush();
  release();
  await Promise.all([first, latest]);
  assert.deepEqual(saved, ['旧稿', '最新稿']);
});

test('failed speech autosave cannot silently flush without writing the latest transcript', async () => {
  const { createSpeechTranscriptSaver } = await import('../src/pages/speech-transcript-save.ts');
  const attempted: string[] = [];
  const saver = createSpeechTranscriptSaver(async value => {
    attempted.push(value);
    if (attempted.length <= 2) throw new Error('temporary failure');
  }, 60_000);
  saver.schedule('尚未保存的合成稿');
  await assert.rejects(saver.flush(), /temporary failure/);
  await assert.rejects(saver.flush(), /temporary failure/);
  await saver.flush();
  assert.deepEqual(attempted, Array(3).fill('尚未保存的合成稿'));
});

test('a failed in-flight speech autosave never overwrites newer edits or resurrects a cancelled draft', async () => {
  const { createSpeechTranscriptSaver } = await import('../src/pages/speech-transcript-save.ts');
  for (const cancel of [false, true]) {
    let rejectFirst!: (reason: Error) => void;
    const attempted: string[] = [];
    const saver = createSpeechTranscriptSaver(value => {
      attempted.push(value);
      return attempted.length === 1 ? new Promise<void>((_resolve, reject) => { rejectFirst = reject; }) : Promise.resolve();
    }, 60_000);
    saver.schedule('旧合成稿');
    const first = saver.flush();
    if (cancel) saver.cancel();
    else saver.schedule('新合成稿');
    rejectFirst(new Error('temporary failure'));
    await assert.rejects(first, /temporary failure/);
    await saver.flush();
    assert.deepEqual(attempted, cancel ? ['旧合成稿'] : ['旧合成稿', '新合成稿']);
  }
});

test('live puts output first, offers the two roles, and keeps offline controls disabled', async () => {
  const html = await view('live');
  const page = html.slice(html.indexOf('<main'));
  assert.match(page, /<header class="interaction-heading">[\s\S]*?<h1>直播管理<\/h1>[\s\S]*?aria-label="直播桌宠"[\s\S]*?class="theme-toggle"/);
  const composer = page.match(/<div class="live-danmaku-controls">([\s\S]*?)<\/div>/)?.[1] ?? '';
  assert.deepEqual([...composer.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map(match => match[1]), ['发送演练弹幕']);
  assert.match(page, /舞台输出[\s\S]*?布景与摆位[\s\S]*?主播互动[\s\S]*?打招呼[\s\S]*?开心一下[\s\S]*?比个心[\s\S]*?弹幕演练/);
  for (const text of ['暮色小屋', '雨夜阁楼', '云海露台', '蓝天草原', '森林篝火', '录音棚', '未连接桌面工作区', '1920 × 1080', '静音']) assert.ok(page.includes(text), text);
  assert.match(page, /<select[^>]*aria-label="直播桌宠"[^>]*>[\s\S]*?龙妹<\/option>[\s\S]*?鲸鱼妹<\/option>/);
  for (const text of ['保存布景', '开启直播台', '预览舞台', '复制 OBS 地址', '打招呼', '开心一下', '比个心']) {
    assert.match(buttonWithText(page, text), /disabled=""/, text);
  }
  for (const text of ['LOCAL OUTPUT', '选择布景、触发动作，向 OBS 提供本机画面。', '开启本机节目源，不会推流。',
    '点布景卡选景，点右上角图标预览。', '手动动作和对应台词只送上舞台。', '「预览舞台」会在独立窗口打开节目画面。',
    '当前布景已保存。', '开启直播台后可以演练。', '停止演练', '启用龙妹声音', '停止龙妹声音']) {
    assert.ok(!page.includes(text), `obsolete copy: ${text}`);
  }
  assert.match(page, /<button(?=[^>]*aria-label="发送演练弹幕")(?=[^>]*aria-keyshortcuts="Enter")(?=[^>]*disabled="")[^>]*>/);
  assert.doesNotMatch(page, /live-danmaku-conversation|<kbd>Enter<\/kbd>|0 \/ 120/);
  assert.doesNotMatch(page, /live-danmaku-steps|演练进度/);
  assert.doesNotMatch(page, /模拟一次|模拟问候|晨光书房|已开播|已连接平台|live-stage-hero|布景示意|房间草稿|平台能力|关闭直播台|<iframe|type="password"|type="file"/);
  assert.equal((page.match(/type="radio"/g) ?? []).length, 6);
  assert.equal((page.match(/-cover\.webp/g) ?? []).length, 6);
  for (const scene of ['暮色小屋', '雨夜阁楼', '云海露台', '蓝天草原', '森林篝火', '录音棚']) {
    const preview = page.match(new RegExp(`<button[^>]*aria-label="预览布景：${scene}"[^>]*>`))?.[0];
    assert.ok(preview, scene);
    assert.doesNotMatch(preview, /disabled/);
    assert.match(preview, /aria-haspopup="dialog"/);
  }
  const sceneChoices = [...page.matchAll(/<label class="live-scene-choice">([\s\S]*?)<\/label>(<button[^>]*class="live-scene-preview"[^>]*>)/g)];
  assert.equal(sceneChoices.length, 6, 'each card has a separate preview button');
  for (const [, choice, preview] of sceneChoices) {
    assert.ok(choice && preview);

    assert.match(choice, /type="radio"/);
    assert.match(choice, /<img [^>]*-cover\.webp/);
    assert.doesNotMatch(choice, /<button/);
    assert.match(preview, /aria-haspopup="dialog"/);
  }
  assert.match(page, /<div class="live-scene-controls"><fieldset class="live-scenes">[\s\S]*?<\/fieldset><div class="live-adjustments">[\s\S]*?角色位置与大小[\s\S]*?保存布景[\s\S]*?<p class="live-hint live-scene-status" role="status">[\s\S]*?<\/p><\/div><\/div>/);
  assert.doesNotMatch(page, /<fieldset class="live-scenes" disabled|type="range"/);
  assert.match(page, /<fieldset class="live-placement" disabled=""/);
  for (const label of ['横向位置', '角色大小']) {
    assert.match(page, new RegExp(`aria-label="减少${label}"`));
    assert.match(page, new RegExp(`aria-label="增加${label}"`));
  }
  assert.match(page, /<input(?=[^>]*type="number")(?=[^>]*min="25")(?=[^>]*max="75")[^>]*>/);
  assert.match(page, /<input(?=[^>]*type="number")(?=[^>]*min="75")(?=[^>]*max="125")[^>]*>/);
  assert.equal((page.match(/<input[^>]*type="radio"[^>]*disabled/g) ?? []).length, 6);

});

test('live rehearsal stays composer-only and keeps processing and failure feedback', async () => {
  const props = { notice: '', available: true, locked: false, unavailableHint: '', onSend: async () => true };
  for (const [state, feedback] of [
    [{ phase: 'generating' }, '主播正在读弹幕、组织回复。'],
    [{ phase: 'synthesizing' }, '正在用本机音色生成节目语音。'],
    [{ phase: 'published' }, ''],
    [{ phase: 'failed', error: 'model-failed' }, '没收到可播的回复'],
    [{ phase: 'stopped' }, ''],
  ] as const) {
    const html = await renderWorkspace(createElement(LiveDanmaku, { ...props, state }));
    assert.match(html, /<textarea[^>]*maxLength="120"/i);
    assert.match(html, /<label[^>]*>观众弹幕<\/label>/);
    assert.doesNotMatch(html, /测试输入|第一个已保存服务商的默认模型，可能计费|不连接直播平台|<textarea[^>]*aria-describedby=/);
    assert.match(html, /aria-keyshortcuts="Enter"/);
    assert.doesNotMatch(html, /live-danmaku-conversation|合成回复|已送上舞台|<kbd>Enter<\/kbd>|0 \/ 120/);
    if (feedback) assert.match(html, new RegExp(`role="status"[^>]*>${feedback}`));
    else assert.doesNotMatch(html, /role="status"/);
    assert.doesNotMatch(html, /停止演练|live-danmaku-footer/);
  }
});

const buttonWithText = (html: string, label: string) => {
  const found = [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].find(([, body]) => body!.replace(/<(?:span|small)[^>]*aria-hidden="true"[^>]*>[^<]*<\/(?:span|small)>/g, '').replace(/<[^>]*>/g, '') === label);
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

test('live sharing stays opt-in and renders no private records or requests before opening management', async () => {
  const { LiveSharing } = await import('../src/pages/LiveSharing.tsx');
  const { renderToStaticMarkup } = await import('react-dom/server');
  let calls=0;const unavailable=async()=>{calls++;return {ok:false,error:'unavailable'} as const;};
  const bridge={readShares:unavailable,writeShares:unavailable} as never;
  const html=renderToStaticMarkup(createElement(LiveSharing,{role:'longmei',petID:'pet-synthetic',bridge,locked:false}));
  assert.match(html,/直播资料授权/);assert.match(html,/aria-expanded="false"/);assert.match(html,/与在线聊天授权独立/);
  assert.doesNotMatch(html,/确认直播授权|当前版本正文/);assert.equal(calls,0);
  const offline=renderToStaticMarkup(createElement(LiveSharing,{role:'dafeiyu',petID:null,locked:false}));
  assert.match(offline,/<button[^>]*disabled=""[^>]*>管理授权/);
});
