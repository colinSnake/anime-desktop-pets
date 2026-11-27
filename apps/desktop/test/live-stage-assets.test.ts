import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stageMediaManifest, loadStageAssets, isPinnedStageAsset, liveStageMediaDirectory, hasRequiredStageActions } from '../src/live-stage/assets.ts';

const whalePins = [
  ['idle', 'idle.webm', 441437, 'deb965d05a85dacf5ff4a20faa757846f0d11679598c3ec578a5571487660395'],
  ['companion-wave', 'companion-wave.webm', 421669, '48cd729ccdcf746369942ea954d242e9afdd5643e1dac3827fa5e67450eb8776'],
  ['companion-jump', 'companion-jump.webm', 538110, '86dcb0c3dd7b651de9c107e927d57a5c4224599101706dbdcc782fa48bcd0ad7'],
  ['companion-49c0d89c0992', 'companion-49c0d89c0992.webm', 352213, 'e3f92df2cf182fdcb109ad0a865689d66e0a0d10db14c1528e5b3cb2f0bf090d'],
] as const;

test('Whale Girl stage manifest admits only its pinned idle and three presenter actions', () => {
  const manifest = stageMediaManifest('dafeiyu');
  assert.deepEqual(manifest.map(({ id, file, bytes, sha256 }) => [id, file, bytes, sha256]), whalePins);
  assert.deepEqual(stageMediaManifest('longmei').map(({ id }) => id), ['idle', '01', '18', '20']);
});

test('stage media hash validation accepts the pinned bytes only', () => {
  const bytes = Buffer.from('synthetic private stage bytes');
  const pin = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  assert.equal(isPinnedStageAsset(bytes, pin), true);
  assert.equal(isPinnedStageAsset(Buffer.concat([bytes, Buffer.from('x')]), pin), false);
});

test('Whale Girl stage fails closed when its own required clips are absent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'live-stage-whale-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, 'bundle'), whale = join(root, 'companion');
  await (await import('node:fs/promises')).mkdir(bundle);
  await (await import('node:fs/promises')).mkdir(whale);
  for (const [name, data] of [
    ['index.html', '<!doctype html>'], ['stage.css', ''], ['stage.js', ''],
    ...['desk-room','rain-loft','cloud-terrace','meadow','forest','studio'].flatMap(id => [[`${id}-room.webp`, 'room'], [`${id}-desk.webp`, 'desk']]),
  ]) await writeFile(join(bundle, name as string), data as string);
  await assert.rejects(loadStageAssets(bundle, whale, 'dafeiyu'));
});

test("live stage resolves each presenter's private media directory without falling back across roles", () => {
  const root = join(tmpdir(), 'workspace-video');
  assert.equal(liveStageMediaDirectory(root, 'longmei'), root);
  assert.equal(liveStageMediaDirectory(root, 'dafeiyu'), join(root, 'companion'));
});

test('a role stage opens only when every fixed presenter action is staged', () => {
  const whale = ['companion-wave','companion-jump','companion-49c0d89c0992'];
  assert.equal(hasRequiredStageActions('dafeiyu', whale), true);
  assert.equal(hasRequiredStageActions('dafeiyu', whale.slice(1)), false);
  assert.equal(hasRequiredStageActions('longmei', ['01','18','20']), true);
});
