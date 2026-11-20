import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stageElectronMacApp } from './lib/pet-electron-macos-stage.mjs';

test('packaged app layout keeps the service and Harness runtime outside ASAR', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pet-electron-stage-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const desktopDist = join(root, 'desktop-dist'), servicePackage = join(root, 'service');
  const serviceDist = join(servicePackage, 'dist'), node = join(root, 'node');
  const electronApp = join(root, 'Electron.app'), outputApp = join(root, 'Pet Fixture.app');
  const appRoot = join(outputApp, 'Contents/Resources/app');
  await mkdir(join(electronApp, 'Contents/Resources'), { recursive: true });
  await writeFile(join(electronApp, 'Contents/Resources/base'), 'Electron fixture');
  await symlink('base', join(electronApp, 'Contents/Resources/base-link'));
  await mkdir(join(desktopDist, 'startup'), { recursive: true });
  await mkdir(join(desktopDist, 'branding'), { recursive: true });
  await mkdir(serviceDist, { recursive: true });
  await writeFile(join(desktopDist, 'main.cjs'), 'desktop');
  await writeFile(join(desktopDist, 'startup/startup.mp4'), 'local only');
  await writeFile(join(desktopDist, 'branding/pet-cover.png'), 'local only');
  await writeFile(join(servicePackage, 'package.json'), JSON.stringify({ name: '@pet/app-service', exports: './dist/entry.cjs' }));
  await writeFile(join(serviceDist, 'entry.cjs'), 'service');
  await writeFile(node, 'standalone node');
  await chmod(node, 0o755);
  const calls = [];
  const options = {
    electronApp, outputApp, desktopDist, servicePackage, nodeExecutable: node,
    stageRuntime: async (source, destination) => {
      calls.push([source, destination]);
      await mkdir(destination); // The real stager requires a fresh destination.
      await mkdir(join(destination, 'apps/app-service/node_modules'), { recursive: true });
      await writeFile(join(destination, 'apps/app-service/node_modules/.stage-marker'), 'runtime');
      return { packages: 1, payloadBytes: 7, payloadFiles: 1 };
    },
  };
  const result = await stageElectronMacApp(options);
  assert.deepEqual(calls, [[servicePackage, appRoot]]);
  assert.equal(result.appRoot, appRoot);
  assert.equal(await readFile(join(appRoot, 'package.json'), 'utf8'), JSON.stringify({ name: 'anime-desktop-pets', private: true, main: 'dist/main.cjs' }));
  assert.equal(await readFile(join(appRoot, 'dist/main.cjs'), 'utf8'), 'desktop');
  assert.equal(await readFile(join(appRoot, 'apps/app-service/dist/entry.cjs'), 'utf8'), 'service');
  assert.equal(await readlink(join(appRoot, 'node_modules/@pet/app-service')), '../../apps/app-service');
  const helper = join(outputApp, 'Contents/Helpers/pet-harness-node');
  assert.equal(result.harnessNode, helper);
  assert.equal(result.stats.payloadBytes, 7);
  assert.equal(await readFile(helper, 'utf8'), 'standalone node');
  assert((await stat(helper)).mode & 0o111);
  await assert.rejects(stat(join(appRoot, 'dist/startup/startup.mp4')), { code: 'ENOENT' });
  await assert.rejects(stat(join(appRoot, 'dist/branding/pet-cover.png')), { code: 'ENOENT' });
  assert.equal(await readFile(join(appRoot, 'apps/app-service/node_modules/.stage-marker'), 'utf8'), 'runtime');
  assert.equal(await readlink(join(outputApp, 'Contents/Resources/base-link')), 'base');
  await assert.rejects(stageElectronMacApp(options), { code: 'ERR_FS_CP_EEXIST' });
  assert.equal(calls.length, 1);
});
