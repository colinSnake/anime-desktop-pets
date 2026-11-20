import assert from 'node:assert/strict';
import test from 'node:test';
import { adjustWorkspacePlacement, watchWorkspaceDisplayChanges } from '../src/workspace-display-recovery.ts';

const primary = { x: 0, y: 25, width: 1440, height: 850 };
const external = { x: -1600, y: -80, width: 1600, height: 940 };
const saved = { x: -1500, y: 60, width: 950, height: 640 };
const centered = { x: 245, y: 130, width: 950, height: 640 };

function windowOn(bounds = saved, minSize = [760, 560]) {
  const state = { destroyed: false, visible: true, minimized: false, maximized: false, fullScreen: false };
  const mutations: unknown[] = [];
  const window = {
    isDestroyed: () => state.destroyed, isVisible: () => state.visible, isMinimized: () => state.minimized,
    isMaximized: () => state.maximized, isFullScreen: () => state.fullScreen,
    getNormalBounds: () => bounds, getMinimumSize: () => minSize,
    setMinimumSize: (width: number, height: number) => { minSize = [width, height]; mutations.push(minSize); },
    setBounds: (next: typeof bounds, animate: boolean) => { bounds = next; mutations.push({ next, animate }); },
  };
  return { window, state, mutations };
}

const live = (win: ReturnType<typeof windowOn>['window'], areas = [primary]) =>
  adjustWorkspacePlacement(win, 'display', () => ({ primary, areas }));

test('a visible window stranded by unplugging a display is moved without animation', () => {
  const { window, mutations } = windowOn();
  assert.deepEqual(live(window), { before: saved, after: centered, relocated: true });
  assert.deepEqual(mutations, [{ next: centered, animate: false }]);
});

test('a live change keeps a reachable window and tolerates a transient empty work area', () => {
  const { window, mutations } = windowOn(saved, [640, 480]);
  assert.equal(live(window, [primary, external]), undefined);
  assert.equal(adjustWorkspacePlacement(window, 'display', () => ({ primary: { ...primary, width: 0 }, areas: [] })), undefined);
  assert.deepEqual(mutations, []);
});

test('displays are only read for a live normal window; special windows wait until restored', () => {
  const { window, state, mutations } = windowOn();
  for (const key of ['destroyed', 'visible', 'minimized', 'maximized', 'fullScreen'] as const) {
    state[key] = !state[key];
    assert.equal(adjustWorkspacePlacement(window, 'display', () => assert.fail('must defer display lookup')), undefined, key);
    state[key] = !state[key];
  }
  assert.deepEqual(mutations, []);
  assert.deepEqual(live(window)?.after, centered);
});

test('explicit reopen can adjust a hidden window, restoring the proper minimum for its display', () => {
  const { window, state, mutations } = windowOn(centered, [640, 480]);
  state.visible = false;
  assert.deepEqual(adjustWorkspacePlacement(window, 'reopen', () => ({ primary, areas: [primary] })), {
    before: centered, after: centered, relocated: false,
  });
  assert.deepEqual(mutations, [[760, 560]]);
});

test('display events coalesce, use the latest readings, and cannot act after disposal', () => {
  let listener!: () => void, detached = 0, cancelled = 0, fires = 0;
  const callbacks: Array<() => void> = [];
  const { window, mutations } = windowOn();
  let areas = [primary, external];
  const dispose = watchWorkspaceDisplayChanges(notify => {
    listener = notify;
    return () => { detached++; };
  }, () => { fires++; live(window, areas); }, (_delay, callback) => {
    callbacks.push(callback);
    return () => { cancelled++; };
  });
  listener(); listener(); listener();
  assert.equal(callbacks.length, 1);
  assert.equal(fires, 0);
  areas = [primary];
  callbacks[0]!();
  assert.equal(fires, 1);
  assert.deepEqual(mutations, [{ next: centered, animate: false }]);
  listener();
  assert.equal(callbacks.length, 2);
  dispose(); dispose();
  callbacks[1]!(); listener();
  assert.equal(detached, 1);
  assert.equal(cancelled, 1);
  assert.equal(fires, 1);
  assert.equal(callbacks.length, 2);
});
