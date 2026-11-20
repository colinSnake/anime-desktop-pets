import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceStatus, type WorkspaceStatusMenu } from '../src/workspace-status.ts';
import type { PetResult, WorkspaceData } from '../../../packages/contracts/src/pets.ts';

const state = (linkage: WorkspaceData['linkage'] = 'active', phases: WorkspaceData['instances'][number]['phase'][] = []): PetResult => ({
  ok: true, workspace: { revision: 0, theme: 'system', catalog: [], maximumRunning: 3, linkage,
    instances: phases.map((phase, index) => ({ id: `pet-${index}`, displayName: 'SYNTHETIC-NAME', phase, enabled: true, autoStartOnLaunch: false,
      package: { id: 'sample.pet', version: '1.0.0' }, preferences: { size: 256, scheduledActivity: true, movement: false, hideInFullscreen: false } })) },
});
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
function fixture(read: () => Promise<PetResult> = async () => state()) {
  const events: string[] = [], menus: WorkspaceStatusMenu[] = [];
  let reads = 0;
  const status = new WorkspaceStatus({ list: () => { reads++; return read(); },
    render: menu => menus.push(menu), open: () => events.push('open'), hide: () => events.push('hide'), destroy: () => { events.push('destroy'); } });
  status.render();
  return { status, events, menu: () => menus.at(-1)!, reads: () => reads };
}

test('boot waits for confirmed local service then workspace first paint; refresh displays confirmed phases only', async () => {
  const pending = deferred<PetResult>();
  const f = fixture(() => pending.promise);
  assert.deepEqual(f.menu(), { label: '正在启动本地服务…', canOpen: false, canRefresh: false });
  f.status.open(); await f.status.refresh();
  assert.equal(f.reads(), 0); assert.deepEqual(f.events, []);
  f.status.serviceReady();
  assert.deepEqual(f.menu(), { label: '正在加载管理工作区…', canOpen: false, canRefresh: false });
  const loaded = f.status.windowReady();
  assert.deepEqual(f.menu(), { label: '正在读取本机状态…', canOpen: true, canRefresh: false });
  await f.status.refresh(); await f.status.windowReady();
  assert.equal(f.reads(), 1);
  pending.resolve(state('stop-unconfirmed', ['running', 'failed', 'stopping']));
  await loaded;
  assert.deepEqual(f.menu(), { label: '上次确认：停止未确认 · 运行 1 · 占用 3/3 槽', canOpen: true, canRefresh: true });
});

test('close hides a reopenable window and quit removes the tray without intercepting window destruction', async () => {
  const f = fixture();
  const close = () => f.status.closeWindow(() => f.events.push('prevent'));
  close(); assert.deepEqual(f.events, []);
  f.status.serviceReady(); await f.status.windowReady();
  close(); f.status.open();
  assert.deepEqual(f.events, ['prevent', 'hide', 'open']);
  f.status.dispose(); f.status.dispose(); close(); f.status.open();
  assert.deepEqual(f.events, ['prevent', 'hide', 'open', 'destroy']);
});

test('a failed refresh clears the old status without leaking details and can recover', async () => {
  let count = 0;
  const f = fixture(async () => {
    if (++count === 2) throw new Error('/private/path secret');
    return state(count === 1 ? 'paused' : 'active');
  });
  f.status.serviceReady(); await f.status.windowReady();
  assert.match(f.menu().label, /^上次确认：已暂停/);
  await f.status.refresh();
  assert.deepEqual(f.menu(), { label: '本机状态未确认', canOpen: true, canRefresh: true });
  await f.status.refresh();
  assert.match(f.menu().label, /^上次确认：联动可用/);
});

for (const end of ['windowUnavailable', 'dispose'] as const) test(`${end} prevents late reads from making the workspace reopenable`, async () => {
  const result = deferred<PetResult>();
  const f = fixture(() => result.promise);
  f.status.serviceReady(); const request = f.status.windowReady();
  f.status[end]();
  const before = f.menu();
  result.resolve(state('paused'));
  await request;
  f.status.open(); f.status.closeWindow(() => f.events.push('prevent'));
  assert.equal(f.menu(), before);
  assert.ok(!f.events.includes('prevent') && !f.events.includes('open'));
  if (end === 'windowUnavailable') assert.deepEqual(before, { label: '管理工作区不可用', canOpen: false, canRefresh: false });
});

test('tray disposal immediately stops menu actions and waits for its owned asynchronous cleanup once', async () => {
  const cleanup = deferred<void>();
  let calls = 0, completed = false;
  const status = new WorkspaceStatus({ list: async () => state(), render: () => {},
    open: () => assert.fail('closed workspace reopened'), hide: () => assert.fail('closed workspace hidden'),
    destroy: () => { calls++; return cleanup.promise; } });
  status.serviceReady(); await status.windowReady();
  const first = status.dispose();
  const second = status.dispose();
  assert.equal(calls, 1);
  status.open(); status.closeWindow(() => assert.fail('closed workspace blocked close'));
  const both = Promise.all([first, second]).then(() => { completed = true; });
  await Promise.resolve(); assert.equal(completed, false);
  cleanup.resolve();
  await both;
  assert.equal(completed, true);
});

test('native linkage uses the advertised action and confirmed revision, then reports only service state', async () => {
  const request = deferred<PetResult>();
  const calls: Array<[string, number]> = [];
  let menu: WorkspaceStatusMenu | undefined;
  const status = new WorkspaceStatus({ list: async () => state(), render: value => { menu = value; },
    open() {}, hide() {}, destroy() {}, linkage: (action, revision) => { calls.push([action, revision]); return request.promise; } });
  await status.changeLinkage('pause');
  assert.deepEqual(calls, []);
  status.serviceReady(); await status.windowReady();
  assert.equal(menu?.linkageAction, 'pause');
  await status.changeLinkage('resume');
  const pause = status.changeLinkage('pause');
  await status.changeLinkage('pause'); await status.refresh();
  assert.deepEqual(calls, [['pause', 0]]);
  assert.equal(menu?.linkageAction, undefined);
  request.resolve(state('paused')); await pause;
  assert.equal(menu?.linkageAction, 'resume');
  assert.match(menu!.label, /已暂停/);
});

test('unconfirmed native linkage stays read-only until refreshed; late replies cannot reopen actions', async () => {
  const request = deferred<PetResult>();
  let menu: WorkspaceStatusMenu | undefined, attempts = 0;
  const status = new WorkspaceStatus({ list: async () => state('stop-unconfirmed'), render: value => { menu = value; },
    open() {}, hide() {}, destroy() {}, linkage: async () => ++attempts === 1 ? { ok: false, error: 'conflict' } : request.promise });
  status.serviceReady(); await status.windowReady();
  assert.equal(menu?.linkageAction, 'pause');
  await status.changeLinkage('pause');
  assert.match(menu!.label, /未确认/);
  await status.changeLinkage('pause'); assert.equal(attempts, 1);
  await status.refresh();
  const pending = status.changeLinkage('pause');
  await status.dispose(); const last = menu;
  request.resolve(state('paused')); await pending;
  assert.equal(menu, last);
});
