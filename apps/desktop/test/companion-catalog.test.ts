import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewResponse } from '../src/video-preview/media.ts';
import type { MenuItemConstructorOptions as Item } from 'electron';
import media from '../../../config/local-companion-media.json';
import inventory from './fixtures/companion-source-inventory.json';
import { companionClips, clipSource, isClip, loops, type Clip } from '../src/video-preview/playback.ts';
import { workspacePetMenu } from '../src/video-preview/pet-menu.ts';

test('the pinned companion catalog includes every upstream WebM exactly once', () => {
  assert.equal(inventory.revision, media.revision);
  assert.equal(inventory.files.length, 114);
  const pins = [media, ...Object.values(media.actions)];
  assert.deepEqual(pins.map(pin => pin.source.split('/').at(-1)!).sort(), inventory.files);
  assert.equal(companionClips.length, 113);
  for (const pin of pins) {
    assert.match(pin.sha256, /^[a-f0-9]{64}$/);
    assert.ok(pin.bytes > 0 && pin.bytes <= 2 * 1024 * 1024);
    assert.match(pin.source, /^dsh-pet\/assets\/webm\/[^/]+\.webm$/);
  }
});

test('every available companion action has a unique categorized native menu item', () => {
  const played: Clip[] = [];
  const menu = workspacePetMenu({ size: 256, hideInFullscreen: false, scheduledActivity: false, movement: false,
    protectedPose: false, reduced: false, task: false, quota: false, companionRole: true, companionClips }, {
    intent() {}, pose: clip => played.push(clip), travel() {}, perform() {}, idle() {}, quota() {}, stop() {},
  });
  const preview = menu.find(item => item.label === '动作预览');
  assert.ok(preview?.enabled);
  assert.ok(Array.isArray(preview.submenu));
  const groups = preview.submenu as Item[];
  assert.ok(groups.length >= 10, 'include movement, work, quota, sleep and all source categories');
  const labels: string[] = [];
  for (const group of groups) {
    assert.ok(group.label);
    assert.ok(Array.isArray(group.submenu));
    assert.ok(group.submenu.length <= 30, 'keep individual categories navigable');
    for (const item of group.submenu as Item[]) {
      assert.ok(item.label);
      labels.push(item.label);
      (item.click as (() => void))();
    }
  }
  assert.deepEqual([...played].sort(), [...companionClips].sort());
  assert.equal(new Set(labels).size, companionClips.length);
});

test('full companion previews use their own pinned file and finish after one play', () => {
  for (const clip of companionClips) {
    assert.equal(isClip(clip), true);
    assert.deepEqual(clipSource(clip), { file: clip });
    assert.equal(loops(clip), clip === 'companion-hover', clip);
  }
  assert.deepEqual(clipSource('companion-rebound'), { file: 'companion-jump', range: [3750, 5300] });
  assert.equal(isClip('companion-unapproved-file'), false);
});


test('every synced action is served only on the companion origin', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'pet-companion-catalog-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  for (const clip of companionClips) {
    const bytes = Buffer.from(clip);
    await writeFile(join(folder, `${clip}.webm`), bytes);
    const request = new Request(`pet-video://companion/${clip}.webm`);
    const response = await previewResponse(folder, request, folder, undefined, 'companion');
    assert.equal(response.status, 200, clip);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    const foreign = await previewResponse(folder, new Request(`pet-video://preview/${clip}.webm`));
    assert.equal(foreign.status, 404);
  }
  assert.equal((await previewResponse(folder, new Request('pet-video://companion/companion-unknown.webm'),
    folder, undefined, 'companion')).status, 404);
});
