import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rename, symlink, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCrossPlatform, publishBuild } from './build-cross-platform.mjs';
import { stageStartupVideo } from './stage-startup-video.mjs';

test('a failed service build preserves both previous dist trees and removes only its staging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pet-build-failure-'));
  try {
    for (const name of ['desktop', 'app-service']) {
      await mkdir(join(root, 'apps', name, 'dist'), { recursive: true });
      await writeFile(join(root, 'apps', name, 'dist', 'previous'), name);
    }
    let calls = 0;
    await assert.rejects(buildCrossPlatform(root, {
      bundle: async ({ outfile }) => {
        if (++calls === 3) throw new Error('synthetic_service_build_failure');
        await writeFile(outfile, 'new output');
      },
      buildUI: async () => assert.fail('must not reach UI'),
    }), /synthetic_service_build_failure/);
    for (const name of ['desktop', 'app-service']) {
      assert.deepEqual(await readdir(join(root, 'apps', name, 'dist')), ['previous']);
      assert.equal(await readFile(join(root, 'apps', name, 'dist', 'previous'), 'utf8'), name);
    }
    assert.deepEqual(await readdir(join(root, '.local')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('promotion failure restores both previous output directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pet-build-rollback-'));
  try {
    const outputs = ['desktop', 'service'].map(name => ({ stage: join(root, name + '-stage'), target: join(root, name), backup: join(root, name + '-backup') }));
    for (const output of outputs) {
      await mkdir(output.target); await mkdir(output.stage);
      await writeFile(join(output.target, 'value'), 'previous');
      await writeFile(join(output.stage, 'value'), 'new');
    }
    let calls = 0;
    await assert.rejects(publishBuild(outputs, async (...args) => {
      if (++calls === 4) throw new Error('synthetic_promotion_failure');
      await rename(...args);
    }), /synthetic_promotion_failure/);
    for (const output of outputs) assert.equal(await readFile(join(output.target, 'value'), 'utf8'), 'previous');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('macOS Keychain helper build failure cannot publish the service or desktop trees', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pet-keychain-build-failure-'));
  try {
    for (const name of ['desktop', 'app-service']) {
      await mkdir(join(root, 'apps', name, 'dist'), { recursive: true });
      await writeFile(join(root, 'apps', name, 'dist', 'previous'), name);
    }
    await assert.rejects(buildCrossPlatform(root, {
      bundle: async ({ outfile }) => writeFile(outfile, 'new output'),
      buildKeychainHelper: async (_root, output) => { assert.match(output,/[/\\]service[/\\]model-keychain$/); throw new Error('synthetic_native_build_failure'); },
      buildUI: async () => assert.fail('must not reach UI'),
    }), /synthetic_native_build_failure/);
    for (const name of ['desktop', 'app-service']) assert.deepEqual(await readdir(join(root, 'apps', name, 'dist')), ['previous']);
    assert.deepEqual(await readdir(join(root, '.local')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('macOS presence helper build failure preserves both outputs', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pet-presence-build-failure-'));
  try {
    for (const name of ['desktop', 'app-service']) {
      await mkdir(join(root, 'apps', name, 'dist'), { recursive: true });
      await writeFile(join(root, 'apps', name, 'dist', 'previous'), name);
    }
    await assert.rejects(buildCrossPlatform(root, {
      bundle: async ({ outfile }) => writeFile(outfile, 'new output'),
      buildKeychainHelper: async (_root, output) => writeFile(output, 'synthetic keychain helper'),
      buildPresenceHelper: async (_root, output) => {
        assert.match(output, /[/\\]desktop[/\\]codex-presence$/);
        throw new Error('synthetic_presence_build_failure');
      },
      buildUI: async () => assert.fail('must not reach UI'),
    }), /synthetic_presence_build_failure/);
    for (const name of ['desktop', 'app-service']) {
      assert.deepEqual(await readdir(join(root, 'apps', name, 'dist')), ['previous']);
    }
    assert.deepEqual(await readdir(join(root, '.local')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('startup asset is optional and copied byte-for-byte with its notice; invalid media is left out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pet-optional-startup-'));
  try {
    const page = join(root, 'apps', 'desktop', 'startup'), media = join(root, 'resources', 'media');
    await mkdir(page, { recursive: true }); await mkdir(media, { recursive: true }); await mkdir(join(root, 'licenses'));
    for (const name of ['index.html', 'player.css', 'player.js']) await writeFile(join(page, name), name);
    await writeFile(join(root, 'licenses', 'startup-media.md'), 'synthetic notice');
    await stageStartupVideo(root, join(root, 'missing'));
    assert.deepEqual((await readdir(join(root, 'missing'))).sort(), ['index.html', 'player.css', 'player.js']);
    const asset = join(media, 'startup.mp4');
    if (process.platform !== 'win32') {
      const other = join(root, 'other.mp4');
      await writeFile(other, 'must not follow'); await symlink(other, asset);
      await stageStartupVideo(root, join(root, 'linked'));
      await assert.rejects(readFile(join(root, 'linked', 'startup.mp4')), { code: 'ENOENT' });
      await rm(asset);
    }
    await writeFile(asset, ''); await truncate(asset, 128 * 1024 * 1024 + 1);
    await stageStartupVideo(root, join(root, 'oversized'));
    await assert.rejects(readFile(join(root, 'oversized', 'startup.mp4')), { code: 'ENOENT' });
    const bytes = Buffer.from([0, 1, 2, 3, 255]);
    await writeFile(asset, bytes);
    await stageStartupVideo(root, join(root, 'copied'));
    assert.deepEqual(await readFile(join(root, 'copied', 'startup.mp4')), bytes);
    assert.equal(await readFile(join(root, 'copied', 'startup-media-license.md'), 'utf8'), 'synthetic notice');
  } finally { await rm(root, { recursive: true, force: true }); }
});
