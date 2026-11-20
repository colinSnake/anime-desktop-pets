import assert from 'node:assert/strict';
import test from 'node:test';
import type { MenuItemConstructorOptions } from 'electron';
import { workspacePetMenu } from '../src/video-preview/pet-menu.ts';
import { loops } from '../src/video-preview/playback.ts';

const find = (items: readonly MenuItemConstructorOptions[], label: string) => {
  const item = items.find(item => item.label === label);
  assert.ok(item, label);
  return item;
};
const children = (item: MenuItemConstructorOptions) => {
  assert.ok(Array.isArray(item.submenu));
  return item.submenu;
};

test('native menu reflects applied values, dispatches fixed intents, and groups one-shot previews', () => {
  const fired: unknown[] = [];
  const actions = {
    intent: (intent: unknown) => { fired.push(intent); }, pose: (clip: Parameters<typeof loops>[0]) => { assert.ok(!loops(clip)); fired.push(clip); },
    travel: (move: string) => { fired.push(move); }, perform: () => {}, idle: () => {}, quota: () => {}, stop: () => {},
  };
  const state = { size: 256, hideInFullscreen: true, scheduledActivity: false, movement: true, protectedPose: false, reduced: false, task: false, quota: true };
  const menu = workspacePetMenu(state, actions);
  const click = (item: MenuItemConstructorOptions) => { assert.ok(item.click); Reflect.apply(item.click, null, []); };
  click(find(menu, '隐藏桌宠'));
  const full = find(menu, '全屏时自动隐藏');
  assert.equal(full.checked, true);
  click(full);
  const sizes = children(find(menu, '桌宠大小'));
  assert.equal(sizes.length, 5);
  assert.equal(find(sizes, '100%（256 × 256）').checked, true);
  click(find(sizes, '75%（192 × 192）'));
  const activity = children(find(menu, '自主活动'));
  assert.equal(find(activity, '定时播放动作').checked, false);
  click(find(activity, '允许蹦跳移动'));
  const travel = children(find(activity, '走路 / 跑步 / 飞行'));
  assert.equal(travel.length, 6);
  click(find(travel, '飞行（向左）'));
  const previews = children(find(menu, '动作预览'));
  assert.deepEqual(previews.map(item => children(item).length), [15, 5, 6]);
  click(children(find(previews, '待机差分动画'))[0]!);
  assert.deepEqual(fired, [{ kind: 'hide' }, { kind: 'hideInFullscreen', value: false }, { kind: 'size', value: 192 }, { kind: 'movement', value: false }, 'move03left', 'once-idle']);
  for (const restricted of [{ reduced: true }, { protectedPose: true }, { task: true }]) {
    const next = workspacePetMenu({ ...state, ...restricted }, actions);
    assert.equal(find(children(find(next, '自主活动')), '走路 / 跑步 / 飞行').enabled, false);
  }
});
