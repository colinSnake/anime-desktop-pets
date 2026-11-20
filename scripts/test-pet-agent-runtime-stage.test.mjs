import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as stage from './lib/pet-sdk-runtime-stage.mjs';
import { watchRuntimeOwner } from './lib/pet-sdk-owner-channel.mjs';
const { stageHarnessRuntime, HARNESS_VERSION } = stage;

async function layout(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pet-stage-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimePackage = join(root, 'reference', 'packages', 'runtime-deepseek');
  const store = resolve(runtimePackage, '../../node_modules/.pnpm');
  const deepseek = name => `@deepseek-ai/${name}`;
  const sdk = deepseek('dsh-sdk-client'), cli = deepseek('dsh'), provider = deepseek('dsh-llm-pi-ai');
  const pkg = (slot, name) => join(store, slot, 'node_modules', name);
  async function add(slot, manifest) {
    const path = pkg(slot, manifest.name);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'package.json'), JSON.stringify(manifest));
    await writeFile(join(path, 'LICENSE'), 'synthetic notice');
    return path;
  }
  async function link(path, source) {
    await mkdir(dirname(path), { recursive: true });
    await symlink(relative(dirname(path), source), path);
  }
  const cliPath = await add('cli', { name: cli, version: HARNESS_VERSION });
  const sdkPath = await add('sdk', { name: sdk, version: HARNESS_VERSION, dependencies: { [cli]: HARNESS_VERSION } });
  const providerPath = await add('pi', { name: provider, version: HARNESS_VERSION, optionalDependencies: { 'fixture-optional': '1.0.0' } });
  await link(join(runtimePackage, 'node_modules', sdk), sdkPath);
  await link(join(runtimePackage, 'node_modules', cli), cliPath);
  await link(join(store, 'node_modules', provider), providerPath);
  await link(join(store, 'node_modules', cli), cliPath);
  await link(join(store, 'node_modules', 'do-not-copy'), pkg('not-required', 'do-not-copy'));
  const cliDependency = join(store, 'sdk', 'node_modules', cli);
  await link(cliDependency, cliPath);
  await add('not-required', { name: 'do-not-copy', version: '1.0.0' });
  await writeFile(join(runtimePackage, 'private.txt'), 'must not copy checkout files');
  return { root, runtimePackage, store, cliDependency, sdkPath, add, link };
}

async function installProductRoots(f) {
  const service = resolve(f.runtimePackage, '../../apps/app-service');
  const installed = join(service, 'node_modules');
  for (const [slot, name] of [['sdk', 'dsh-sdk-client'], ['pi', 'dsh-llm-pi-ai']]) {
    const pkg = `@deepseek-ai/${name}`;
    await f.link(join(installed, pkg), join(f.store, slot, 'node_modules', pkg));
  }
  const fastify = await f.add('fastify', { name: 'fastify', version: '0.0.0' });
  await f.link(join(installed, 'fastify'), fastify);
  return service;
}

test('the staged fixed closure is relocatable, skips unrelated packages and retains notices', async t => {
  const f = await layout(t);
  const target = join(f.root, 'stage');
  const stats = await stageHarnessRuntime(f.runtimePackage, target);
  assert.equal(stats.packages, 3);
  assert.equal(stats.payloadFiles, 6);
  assert(stats.payloadBytes > 0);
  const moved = join(f.root, 'relocated');
  await rename(target, moved);
  await rm(join(f.root, 'reference'), { recursive: true });
  assert.equal(await readFile(join(moved, 'node_modules/@deepseek-ai/dsh-sdk-client/LICENSE'), 'utf8'), 'synthetic notice');
  const installedCLI = join(moved, 'node_modules/.pnpm/cli/node_modules/@deepseek-ai/dsh');
  assert.equal(await realpath(join(moved, 'node_modules/.pnpm/sdk/node_modules/@deepseek-ai/dsh')), installedCLI);
  assert.equal(await realpath(join(moved, 'node_modules/.pnpm/node_modules/@deepseek-ai/dsh')), installedCLI);
  await assert.rejects(realpath(join(moved, 'node_modules/.pnpm/node_modules/do-not-copy')), { code: 'ENOENT' });
  assert(!isAbsolute(await readlink(join(moved, 'node_modules/@deepseek-ai/dsh'))));
  await assert.rejects(readFile(join(moved, 'private.txt')), { code: 'ENOENT' });
  await assert.rejects(realpath(join(moved, 'node_modules/.pnpm/not-required')), { code: 'ENOENT' });
  assert.match(await readFile(join(moved, 'pet-sdk-runtime-worker.mjs'), 'utf8'), /watchRuntimeOwner/);
});

test('package graph traversal and package payloads cannot point outside the installed store', async t => {
  const f = await layout(t);
  const foreign = join(f.root, 'foreign');
  await mkdir(foreign);
  await writeFile(join(foreign, 'data.txt'), 'not an installed dependency');
  const installedTarget = await readlink(f.cliDependency);
  await rm(f.cliDependency);
  await symlink(foreign, f.cliDependency);
  await assert.rejects(stageHarnessRuntime(f.runtimePackage, join(f.root, 'rejected-dep')), /outside installed store/);
  await rm(f.cliDependency);
  await symlink(installedTarget, f.cliDependency);
  await symlink(join(foreign, 'data.txt'), join(f.sdkPath, 'data.txt'));
  await assert.rejects(stageHarnessRuntime(f.runtimePackage, join(f.root, 'rejected-data')), /package payload link/);
});

test('product staging uses service-local links, with no direct CLI or probe fixtures copied', async t => {
  const f = await layout(t);
  const service = await installProductRoots(f);
  const target = join(f.root, 'product');
  assert.equal((await stage.stageProductHarnessRuntime(service, target)).packages, 4);
  const moved = join(f.root, 'relocated product');
  await rename(target, moved);
  await rm(join(f.root, 'reference'), { recursive: true });
  const modules = join(moved, 'apps/app-service/node_modules');
  assert.match(await realpath(join(modules, '@deepseek-ai/dsh-sdk-client')), /node_modules\/\.pnpm\/sdk\//);
  assert.match(await realpath(join(modules, 'fastify')), /node_modules\/\.pnpm\/fastify\//);
  assert.match(await realpath(join(moved, 'node_modules/.pnpm/sdk/node_modules/@deepseek-ai/dsh')), /\.pnpm\/cli\//);
  await assert.rejects(readlink(join(modules, '@deepseek-ai/dsh')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(moved, 'pet-sdk-runtime-worker.mjs')), { code: 'ENOENT' });
});

test('web map trial omits only paired maps from the two audited DSH packages', async t => {
  const f = await layout(t);
  const service = await installProductRoots(f);
  const control = join(f.root, 'control'), trimmed = join(f.root, 'trimmed');
  const targets = [
    ['frontend', '@deepseek-ai/dsh-web-frontend', '0.2.2-rc.5', 'dist/assets/index.js', true],
    ['document', '@deepseek-ai/dsh-client-ui-sidebar-documentpreview', '0.2.2-rc.5', 'lib/client.excel.js', true],
    ['future', '@deepseek-ai/dsh-web-frontend', '0.2.2-rc.6', 'dist/assets/index.js', false],
    ['unlisted', '@deepseek-ai/dsh-client-ui-sidebar-documentpreview', '0.2.2-rc.5', 'lib/other.js', false],
  ];
  const maps = [];
  for (const [slot, name, version, asset, omit] of targets) {
    const path = await f.add(slot, { name, version });
    const owner = slot === 'document' || slot === 'future' ? 'pi' : slot === 'unlisted' ? 'cli' : 'sdk';
    const ownerName = { sdk: 'dsh-sdk-client', cli: 'dsh', pi: 'dsh-llm-pi-ai' }[owner];
    const ownerPath = join(f.store, owner, 'node_modules', '@deepseek-ai', ownerName, 'package.json');
    const manifest = JSON.parse(await readFile(ownerPath, 'utf8'));
    await writeFile(ownerPath, JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, [name]: version } }));
    await f.link(join(f.store, owner, 'node_modules', name), path);
    await mkdir(dirname(join(path, asset)), { recursive: true });
    for (const [file, content] of [[asset, 'runtime'], [`${asset}.map`, 'debug'],
      [`${dirname(asset)}/orphan.js.map`, 'unpaired'], [`${dirname(asset)}/addon.node`, 'native'],
      [`${dirname(asset)}/NOTICE.js.map`, 'notice']]) await writeFile(join(path, file), content);
    maps.push({ path, asset, omit });
  }
  const before = await stage.stageProductHarnessRuntime(service, control);
  const after = await stage.stageProductHarnessRuntime(service, trimmed, { omitWebSourceMaps: true });
  assert.equal(after.packages, before.packages);
  assert.equal(after.payloadFiles, before.payloadFiles - 2);
  assert.equal(after.payloadBytes, before.payloadBytes - 10);
  for (const { path, asset, omit } of maps) {
    const tail = relative(resolve(service, '../..'), path);
    assert.equal(await readFile(join(control, tail, `${asset}.map`), 'utf8'), 'debug');
    assert.equal(await readFile(join(path, `${asset}.map`), 'utf8'), 'debug');
    const map = readFile(join(trimmed, tail, `${asset}.map`), 'utf8');
    if (omit) await assert.rejects(map, { code: 'ENOENT' });
    else assert.equal(await map, 'debug');
    for (const file of [asset, 'LICENSE', 'package.json', `${dirname(asset)}/orphan.js.map`,
      `${dirname(asset)}/addon.node`, `${dirname(asset)}/NOTICE.js.map`]) {
      assert.deepEqual(await readFile(join(trimmed, tail, file)), await readFile(join(control, tail, file)));
    }
  }
});

test('runtime admission closes before start without an owner and revokes immediately on IPC loss', () => {
  const channel = new EventEmitter();
  channel.connected = false;
  const missing = watchRuntimeOwner(channel);
  assert(missing.signal.aborted);
  missing.dispose();
  channel.connected = true;
  const live = watchRuntimeOwner(channel);
  assert(!live.signal.aborted);
  channel.connected = false;
  channel.emit('disconnect');
  assert(live.signal.aborted);
  live.dispose();
  assert.equal(channel.listenerCount('disconnect'), 0);
});
