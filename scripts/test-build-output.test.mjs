import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCrossPlatform, publishBuild } from './build-cross-platform.mjs';

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
