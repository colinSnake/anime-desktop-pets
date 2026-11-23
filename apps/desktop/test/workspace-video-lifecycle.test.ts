import { dafeiyu, longmei } from '../../../packages/contracts/src/built-in-pets.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskAnimation } from '../../app-service/src/task-animation.ts';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PetWorkspace } from '../../app-service/src/pet-workspace.ts';
import { WorkspaceVideoHost } from '../src/workspace-video-host.ts';
import { WorkspaceVideoClient } from '../../app-service/src/workspace-video-client.ts';
import { PetLifecycle } from '../../app-service/src/pet-lifecycle.ts';
import { defaultPreferences } from '../../app-service/src/pet-registry.ts';
import type { PetDefinition } from '../../../packages/contracts/src/pets.ts';

import type { VideoMenuIntent } from '../../app-service/src/workspace-video-protocol.ts';

const pet = (id: string): PetDefinition => ({ id, package: { id: 'local.development.longmei', version: '0.0.0-dev' },
  enabled: true, autoStartOnLaunch: false, preferences: defaultPreferences() });
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture() {
  const windows: { frame(next?: boolean): void; menu(intent: VideoMenuIntent): void; crash(): void; drop(point: { x: number; y: number }): void; startPosition: { x?: number; y?: number }; allowStop: boolean; stops: number; controls: unknown[]; tasks: TaskAnimation[]; rejectDisplaySize?: number }[] = [];
  const host = new WorkspaceVideoHost((input, ended, _slot, drop, _cue, menu) => {
    let frame!: (ok: boolean) => void;
    const ready = new Promise<boolean>(resolve => { frame = resolve; });
    const window = { ready, frame: (ok = true) => frame(ok), crash: () => ended('failed'), drop, menu, startPosition: { x: input.preferences.x, y: input.preferences.y }, allowStop: true, stops: 0, controls: [] as unknown[], tasks: [] as TaskAnimation[],
      applyDisplay(value: { size: number; hideInFullscreen: boolean }) { this.controls.push(value); return value.size !== this.rejectDisplaySize; },
      rejectDisplaySize: undefined as number | undefined,
      applyBehavior(value: { scheduledActivity: boolean; movement: boolean }) { this.controls.push(value); return true; },
      setVisible(value: boolean) { this.controls.push({ visible: value }); return true; },
      applyTaskAnimation(value: TaskAnimation) { this.tasks.push(value); return true; },
      stop() { this.stops++; if (this.allowStop) { ended('stopped'); return true; } return false; },
    };
    windows.push(window);
    return window;
  }, 1000);
  const sendReply = (message: unknown) => client.receive(message);
  const client = new WorkspaceVideoClient(message => host.receive(message, sendReply), 1200);
  const lifecycle = new PetLifecycle({ supports: () => true, create: def => client.controller(def.id, def.package) });
  return { host, client, lifecycle, windows, sendReply };
}

test('video workspace shares the three slots and waits for a current first frame', async () => {
  const { lifecycle, windows, host } = fixture();
  const [a,b,c,d] = ['pet-a','pet-b','pet-c','pet-d'].map(pet) as [PetDefinition, PetDefinition, PetDefinition, PetDefinition];
  b.package = dafeiyu;
  for (const def of [a,b,c]) assert.equal(lifecycle.start(def), undefined);
  assert.equal(lifecycle.phase(a), 'starting');
  assert.equal(lifecycle.start(d), 'limit');
  windows[0]!.frame(); await turn();
  assert.equal(lifecycle.phase(a), 'running');
  assert.deepEqual(lifecycle.applied(a), { size: a.preferences.size, hideInFullscreen: a.preferences.hideInFullscreen, visible: true });
  assert.deepEqual(lifecycle.behavior(a), { status: 'applied', scheduledActivity: a.preferences.scheduledActivity, movement: a.preferences.movement });
  assert.equal(await lifecycle.pauseAll(), true);
  assert.deepEqual(windows.map(window => window.stops), [1,1,1]);
  assert.equal(lifecycle.phase(a), 'stopped');
  assert.equal(lifecycle.start(d), 'busy');
  windows[1]!.frame(); await turn();
  assert.equal(lifecycle.phase(b), 'stopped');
  await lifecycle.close(); host.close();
});

test('a failed stop keeps the slot, and late results from a stopped epoch cannot start a new window', async () => {
  const { lifecycle, windows, host } = fixture();
  const a = pet('pet-a');
  lifecycle.start(a);
  windows[0]!.allowStop = false;
  lifecycle.stop(a); await turn();
  assert.equal(lifecycle.phase(a), 'failed');
  await assert.rejects(lifecycle.forget(a), /instance_active/);
  assert.equal(lifecycle.start(a), 'active');
  windows[0]!.allowStop = true;
  lifecycle.stop(a); await turn();
  lifecycle.start(a);
  windows[0]!.frame(); await turn();
  assert.equal(lifecycle.phase(a), 'starting');
  windows[1]!.frame(); await turn();
  assert.equal(lifecycle.phase(a), 'running');
  windows[1]!.crash(); await turn();
  assert.equal(lifecycle.phase(a), 'failed');
  await lifecycle.close(); host.close();
});

test('main window host rejects unexpected fields and cleans only its own sessions on service loss', async () => {
  const { host, sendReply, lifecycle, windows } = fixture();
  host.receive({ type: 'workspace-video-command', version: 1, id: 'pet-a', seq: 1, op: 'start',
    package: pet('pet-a').package, preferences: defaultPreferences(), path: '/private/file' }, sendReply);
  assert.equal(windows.length, 0);
  lifecycle.start(pet('pet-a'));
  assert.equal(windows.length, 1);
  host.close();
  assert.equal(windows[0]!.stops, 1);
  await turn();
  assert.equal(lifecycle.phase(pet('pet-a')), 'failed');
});


test('only the current running video instance may persist a genuine bounded drop', async () => {
  const { lifecycle, windows, host, sendReply } = fixture();
  const a = pet('pet-a');
  const seen: unknown[] = [];
  lifecycle.setPositionWriter(async (id, point) => { seen.push({ id, ...point }); return true; });
  lifecycle.start(a);
  windows[0]!.drop({ x: -80, y: 101 }); // Not visible before the confirmed first frame.
  windows[0]!.frame(); await turn();
  windows[0]!.drop({ x: -80, y: 101 });
  for (const point of [{ x: NaN, y: 2 }, { x: 1.1, y: 2 }, { x: 2, y: 1_000_001 }, { x: 2, y: 2, path: '/private/file' }]) windows[0]!.drop(point);
  await turn();
  assert.deepEqual(seen, [{ id: 'pet-a', x: -80, y: 101 }]);
  assert.deepEqual(lifecycle.positionFeedback(a), { x: -80, y: 101, status: 'saved' });
  lifecycle.stop(a); await turn();
  lifecycle.start(a);
  windows[1]!.frame(); await turn();
  windows[0]!.drop({ x: 900, y: 101 });
  sendReply({ type: 'workspace-video-drop', version: 1, id: 'pet-a', seq: 1, x: 900, y: 101 });
  windows[1]!.drop({ x: -18, y: 12 }); await turn();
  assert.deepEqual(seen, [{ id: 'pet-a', x: -80, y: 101 }, { id: 'pet-a', x: -18, y: 12 }]);
  await lifecycle.pauseAll();
  windows[1]!.drop({ x: 88, y: 88 });
  assert.equal(seen.length, 2);
  await lifecycle.close(); host.close();
});


test('video drops only advance the workspace revision on commit and reopen at the last saved coordinates', async t => {
  const { lifecycle, windows, host } = fixture();
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pet-video-drop-'));
  const pkg = pet('pet-a').package;
  let fail = false;
  const workspace = new PetWorkspace({ root, catalog: [{ ...pkg, name: '合成桌宠', launchable: true }], lifecycle,
    beforeCommit: async () => { if (fail) throw new Error('synthetic write failure'); },
  });
  t.after(async () => {
    try { await workspace.close(); }
    finally { host.close(); await rm(root, { recursive: true, force: true }); }
  });
  const add = await workspace.mutate('add', { expectedRevision: 0, package: pkg });
  assert.ok(add.ok);
  const id = add.workspace.instances[0]!.id;
  assert.ok((await workspace.mutate('start', { expectedRevision: 1, id })).ok);
  windows[0]!.frame(); await turn();
  windows[0]!.drop({ x: -80, y: 101 });
  const saved = await workspace.list(); assert.ok(saved.ok);
  assert.equal(saved.workspace.revision, 2);
  assert.equal(saved.workspace.instances[0]!.preferences.x, -80);
  fail = true;
  windows[0]!.drop({ x: -21, y: 32 });
  const unchanged = await workspace.list(); assert.ok(unchanged.ok);
  assert.equal(unchanged.workspace.revision, 2);
  assert.equal(unchanged.workspace.instances[0]!.preferences.x, -80);
  assert.deepEqual(unchanged.workspace.instances[0]!.positionFeedback, { x: -21, y: 32, status: 'failed' });
  assert.ok((await workspace.mutate('stop', { expectedRevision: 2, id })).ok);
  await turn();
  assert.ok((await workspace.mutate('start', { expectedRevision: 2, id })).ok);
  assert.deepEqual(windows[1]!.startPosition, { x: -80, y: 101 });
});


test('video controls acknowledge settings without changing the window epoch while applying both behavior preferences', async () => {
  const { lifecycle, windows, host } = fixture();
  const a = pet('pet-a');
  const writes: unknown[] = [];
  lifecycle.setPositionWriter(async (_id, point) => { writes.push(point); return true; });
  lifecycle.start(a);
  assert.equal(await lifecycle.setVisible(a, false), 'active');
  windows[0]!.frame(); await turn();
  const updated = { ...a, preferences: { ...a.preferences, size: 300, scheduledActivity: false, movement: false, hideInFullscreen: false } };
  assert.equal(await lifecycle.applyDisplayPreferences(updated), undefined);
  assert.equal(await lifecycle.applyBehaviorPreferences(updated), undefined);
  assert.equal(await lifecycle.setVisible(a, false), undefined);
  assert.deepEqual(lifecycle.applied(a), { size: 300, hideInFullscreen: false, visible: false });
  assert.deepEqual(lifecycle.behavior(a), { status: 'applied', scheduledActivity: false, movement: false });
  assert.deepEqual(windows[0]!.controls, [{ size: 300, hideInFullscreen: false }, { scheduledActivity: false, movement: false }, { visible: false }]);
  windows[0]!.drop({ x: -100, y: 100 }); await turn();
  assert.deepEqual(writes, [{ x: -100, y: 100 }]);
  assert.equal(await lifecycle.pauseAll(), true);
  assert.equal(await lifecycle.setVisible(a, true), 'active');
  await lifecycle.close(); host.close();
});

test('video behavior requires both boolean flags and the current start generation', async () => {
  const { lifecycle, windows, host, sendReply } = fixture();
  const a = pet('pet-a');
  lifecycle.start(a);
  windows[0]!.frame(); await turn();
  const cmd = { type: 'workspace-video-command', version: 1, id: a.id, seq: 20, epoch: 1, op: 'behavior' };
  assert.equal(host.receive({ ...cmd, value: { movement: true } }, sendReply), false);
  assert.equal(host.receive({ ...cmd, value: { movement: true, scheduledActivity: 1 } }, sendReply), false);
  assert.equal(host.receive({ ...cmd, value: { movement: true, scheduledActivity: true, position: 0 } }, sendReply), false);
  const replies: unknown[] = [];
  const value = { movement: false, scheduledActivity: true };
  assert.equal(host.receive({ ...cmd, epoch: 2, value }, reply => replies.push('result' in reply ? reply.result : 'unexpected')), true);
  assert.deepEqual(replies, ['failed']);
  assert.deepEqual(windows[0]!.controls, []);
  assert.equal(host.receive({ ...cmd, seq: 21, value }, reply => replies.push('result' in reply ? reply.result : 'unexpected')), true);
  assert.deepEqual(replies, ['failed', 'applied']);
  assert.deepEqual(windows[0]!.controls, [value]);
  host.close();
});

test('video task projection is bounded, owned by the current start epoch and revoked on pause', async () => {
  const { lifecycle, windows, host, sendReply } = fixture();
  const a = pet('pet-a');
  lifecycle.start(a);
  lifecycle.updateTaskAnimation({ state: 'working', activeCount: 1, startSerial: 12 });
  assert.equal(windows[0]!.tasks.length, 0);
  windows[0]!.frame(); await turn();
  const cold = windows[0]!.tasks.at(-1);
  assert.ok(cold && cold.expiresAt > Date.now());
  assert.deepEqual(cold, { state: 'working', startSerial: 0, expiresAt: cold.expiresAt });
  lifecycle.updateTaskAnimation({ state: 'working', activeCount: 1, startSerial: 13 });
  const live = windows[0]!.tasks.at(-1);
  assert.ok(live && live.expiresAt > Date.now());
  assert.deepEqual(live, { state: 'working', startSerial: 13, expiresAt: live.expiresAt });
  const cmd = { type: 'workspace-video-command', version: 1, id: 'pet-a', seq: 10, epoch: 1, op: 'task', value: live };
  assert.equal(host.receive({ ...cmd, value: { ...live as object, prompt: 'synthetic private field' } }, sendReply), false);
  const count = windows[0]!.tasks.length;
  assert.equal(await lifecycle.pauseAll(), true);
  lifecycle.updateTaskAnimation({ state: 'working', activeCount: 1, startSerial: 14 });
  host.receive(cmd, sendReply);
  assert.equal(windows[0]!.tasks.length, count);
  await lifecycle.close(); host.close();
});

test('owned caption cues wait for start, belong to one window epoch, and revoke on hide/stop', async () => {
  const spoken: {text: string; eligible: () => boolean}[] = [];
  let revoked = 0;
  let fire: (text: string | undefined, token: number) => void = () => {};
  let frame!: (result: boolean) => void;
  const host = new WorkspaceVideoHost((_input, ended, _slot, _drop, cue) => {
    fire = cue;
    return { ready: new Promise(resolve => { frame = resolve; }), stop() { ended('stopped'); return true; }, setVisible: value => { if (!value) cue(undefined, 1); return true; } };
  });
  const client = new WorkspaceVideoClient(command => host.receive(command, event => client.receive(event)), 1000, {
    offer: (_source, text, eligible) => spoken.push({text, eligible}),
    cancelSource: async () => { revoked++; },
  });
  const controller = client.controller('pet-voice', pet('pet-voice').package);
  const start = controller.start(defaultPreferences());
  fire('先不要读。', 1);
  assert.equal(spoken.length, 0);
  frame(true); await start;
  fire('已呈现。', 1); fire('重复。', 1);
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0]!.eligible(), true);
  assert.equal(await controller.setVisible(false), true);
  assert.equal(spoken[0]!.eligible(), false);
  assert.equal(revoked, 1);
  const old = fire;
  await controller.stop();
  const again = controller.start(defaultPreferences());
  frame(true); await again;
  old('不是新窗口。', 2);
  fire('新的窗口。', 1);
  assert.deepEqual(spoken.map(v => v.text), ['已呈现。', '新的窗口。']);
  fire(undefined, 1);
  assert.equal(spoken[1]!.eligible(), false);
  assert.equal(revoked, 2);
  await controller.close(); host.close();
});

test('native menu edits only the running instance and the selected field; hide is session-only', async t => {
  const { client, lifecycle, windows, sendReply } = fixture();
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pet-video-menu-'));
  let fail = false;
  let interrupted: (() => void) | undefined;
  const def = pet('pet-a');
  const w = new PetWorkspace({ root, catalog: [{ ...def.package, name: 'Test' }], lifecycle,
    beforeCommit: async () => { interrupted?.(); if (fail) throw new Error('test failure'); },
  });
  t.after(async () => { await w.close(); await rm(root, { recursive: true, force: true }); });
  client.setMenuHandler((id, intent, current) => { void w.recordVideoMenu(id, intent, current); });
  const added = await w.mutate('add', { expectedRevision: 0, package: def.package }); assert.ok(added.ok);
  const row = added.workspace.instances[0]!;
  const cloned = await w.mutate('clone', { expectedRevision: 1, id: row.id }); assert.ok(cloned.ok);
  assert.ok((await w.mutate('start', { expectedRevision: 2, id: row.id })).ok);
  const native = windows[0]!;
  native.menu({ kind: 'size', value: 320 }); // Before first-frame confirmation.
  native.frame(); await turn();
  const saved = await w.mutate('save', { expectedRevision: 2, id: row.id, enabled: true, autoStartOnLaunch: false,
    displayName: 'test pet', preferences: { ...row.preferences, hideInFullscreen: !row.preferences.hideInFullscreen } });
  assert.ok(saved.ok);
  native.menu({ kind: 'size', value: 320 });
  const resized = await w.list(); assert.ok(resized.ok);
  assert.equal(resized.workspace.revision, 4);
  assert.deepEqual(resized.workspace.instances[0]!.preferences, { ...saved.workspace.instances[0]!.preferences, size: 320 });
  assert.deepEqual(native.controls, [{ size: 320, hideInFullscreen: row.preferences.hideInFullscreen }]);
  assert.deepEqual(resized.workspace.instances[1], cloned.workspace.instances[1]);
  sendReply({ type: 'workspace-video-menu', version: 1, id: row.id, seq: 77, intent: { kind: 'size', value: 384 } });
  native.menu({ kind: 'size', value: 319 } as unknown as VideoMenuIntent);
  native.menu({ kind: 'size', value: 384, path: '/invalid' } as VideoMenuIntent);
  native.menu({ kind: 'hide' });
  const hidden = await w.list(); assert.ok(hidden.ok);
  assert.equal(hidden.workspace.revision, 4);
  assert.equal(hidden.workspace.instances[0]!.applied?.visible, false);
  fail = true;
  native.menu({ kind: 'movement', value: !row.preferences.movement });
  const failed = await w.list(); assert.ok(failed.ok);
  assert.deepEqual(failed.workspace.instances[0], { ...hidden.workspace.instances[0], menuFeedback: 'save-failed' });
  assert.deepEqual(native.controls.slice(-2), [
    { scheduledActivity: row.preferences.scheduledActivity, movement: !row.preferences.movement },
    { scheduledActivity: row.preferences.scheduledActivity, movement: row.preferences.movement },
  ]);
  native.rejectDisplaySize = 320;
  native.menu({ kind: 'size', value: 384 });
  const rollback = await w.list(); assert.ok(rollback.ok);
  assert.equal(rollback.workspace.instances[0]!.menuFeedback, 'rollback-failed');
  assert.equal(rollback.workspace.instances[0]!.preferences.size, 320);
  assert.equal(rollback.workspace.instances[0]!.applied?.size, 384);
  assert.equal(rollback.workspace.revision, 4);
  fail = false;
  native.rejectDisplaySize = undefined;
  let rejectedPause: ReturnType<typeof w.mutate> | undefined;
  interrupted = () => { interrupted = undefined; rejectedPause = w.mutate('pause', { expectedRevision: 3 }); };
  native.menu({ kind: 'size', value: 256 });
  const resumed = await w.list(); assert.ok(resumed.ok);
  assert.deepEqual(await rejectedPause, { ok: false, error: 'conflict' });
  assert.deepEqual(native.controls.slice(-2), [{ size: 256, hideInFullscreen: row.preferences.hideInFullscreen }, { size: 384, hideInFullscreen: row.preferences.hideInFullscreen }]);
  assert.equal(resumed.workspace.instances[0]!.applied?.size, 384);
  assert.equal(resumed.workspace.revision, 4);
  native.menu({ kind: 'size', value: 384 });
  assert.ok((await w.mutate('pause', { expectedRevision: 4 })).ok);
  native.menu({ kind: 'size', value: 192 }); // Old window after pause.
  const paused = await w.list(); assert.ok(paused.ok);
  assert.equal(paused.workspace.revision, 4);
});

test('a registered companion package is carried by the private start command, not inferred from the instance ID', async () => {
  const sent: unknown[] = [];
  const client = new WorkspaceVideoClient(message => { sent.push(message); return true; }, 25);
  const ref = { id: 'local.community.dafeiyu', version: '0.0.0-dev' };
  const controller = client.controller('pet-random', ref);
  const starting = controller.start(defaultPreferences());
  assert.deepEqual(sent[0], { type: 'workspace-video-command', version: 1, seq: 1, id: 'pet-random', op: 'start', package: ref, preferences: defaultPreferences() });
  client.receive({ type: 'workspace-video-result', version: 1, seq: 1, id: 'pet-random', result: 'running' });
  assert.deepEqual(await starting, { status: 'running' });
});


test('companion registration never starts a player and keeps unsupported behaviors off', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pet-companion-workspace-'));
  const { lifecycle, windows } = fixture();
  const workspace = new PetWorkspace({ root: await realpath(directory), lifecycle, playerMode: 'video',
    catalog: [{ ...dafeiyu, name: '大肥鱼', launchable: true }] });
  t.after(async () => { try { await workspace.close(); } finally { await rm(directory, { force: true, recursive: true }); } });
  const launched = await workspace.startOnLaunch(longmei);
  assert.ok(launched.ok);
  assert.deepEqual(launched.workspace.instances, []);
  const added = await workspace.mutate('add', { expectedRevision: launched.workspace.revision, package: dafeiyu });
  assert.ok(added.ok);
  const whale = added.workspace.instances[0]!;
  assert.equal(whale.displayName, '鲸鱼妹');
  assert.equal(whale.phase, 'stopped');
  assert.equal(whale.autoStartOnLaunch, false);
  assert.equal(whale.preferences.scheduledActivity, false);
  assert.equal(whale.preferences.movement, false);
  const reopened = await workspace.startOnLaunch(longmei);
  assert.ok(reopened.ok);
  assert.equal(reopened.workspace.instances[0]?.phase, 'stopped');
  const saved = await workspace.mutate('save', { id: whale.id, expectedRevision: reopened.workspace.revision,
    displayName: '小蓝', enabled: whale.enabled, autoStartOnLaunch: whale.autoStartOnLaunch, preferences: whale.preferences });
  assert.ok(saved.ok);
  assert.equal(saved.workspace.instances[0]?.displayName, '小蓝');
  assert.equal(windows.length, 0);
});
