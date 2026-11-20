import assert from 'node:assert/strict';
import { link, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fitWorkspace, planWorkspaceReveal, WorkspacePlacement } from '../src/workspace-placement.ts';

const primary = { x: 0, y: 25, width: 1440, height: 850 };
const left = { x: -1600, y: -80, width: 1600, height: 940 };
const saved = { x: -1500, y: 60, width: 950, height: 640 };
const filename = 'workspace-window.json';

function profile(appData: string) { return join(appData, 'AnimeDesktopPets', 'cross-platform-dev'); }
async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const appData = await mkdtemp(join(tmpdir(), 'adp-workspace-window-'));
  t.after(() => rm(appData, { recursive: true, force: true }));
  await mkdir(profile(appData), { recursive: true, mode: 0o700 });
  return { appData, path: join(profile(appData), filename), store: new WorkspacePlacement(appData) };
}

test('restores a normal window on the current display that best matches it, including negative coordinates', () => {
  assert.deepEqual(fitWorkspace(saved, primary, [primary, left]), saved);
  assert.deepEqual(fitWorkspace({ ...saved, x: -1700, y: -200 }, primary, [primary, left]), { ...saved, x: -1600, y: -80 });
  assert.deepEqual(fitWorkspace(undefined, primary, [primary]), { x: 130, y: 50, width: 1180, height: 800 });
});

test('a disconnected monitor falls back to the primary center and clamps to a small work area', () => {
  assert.deepEqual(fitWorkspace(saved, primary, [primary]), { ...saved, x: 245, y: 130 });
  const tiny = { x: 10, y: 20, width: 640, height: 480 };
  assert.deepEqual(fitWorkspace(saved, tiny, [tiny]), tiny);
});

test('reopening moves an unreachable title bar and recomputes the window minimum for the current display', () => {
  const small = { x: 0, y: 25, width: 640, height: 480 };
  const hiddenTitle = { ...saved, x: 190, y: -500 };
  assert.deepEqual(planWorkspaceReveal(hiddenTitle, primary, [primary]), {
    bounds: { ...hiddenTitle, y: 25 }, minimum: { width: 760, height: 560 },
  });
  assert.deepEqual(planWorkspaceReveal(saved, small, [small]), {
    bounds: small, minimum: { width: 640, height: 480 },
  });
  assert.deepEqual(planWorkspaceReveal(small, primary, [primary]), {
    minimum: { width: 760, height: 560 },
  });
  assert.deepEqual(planWorkspaceReveal(saved, primary, [primary, left]), {
    minimum: { width: 760, height: 560 },
  });
});

const skip = process.platform === 'win32' && 'macOS-only profile persistence';
test('a fresh profile writes only a private versioned rectangle and reads it on reopen', { skip }, async t => {
  const { appData, path, store } = await fixture(t);
  assert.equal(await store.read(), undefined);
  assert.equal(await store.save(saved), true);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: 1, bounds: saved });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const reopened = new WorkspacePlacement(appData);
  assert.deepEqual(await reopened.read(), saved);
  assert.equal(await reopened.save({ ...saved, x: 42 }), true);
  assert.deepEqual(await new WorkspacePlacement(appData).read(), { ...saved, x: 42 });
});

test('invalid, unknown or oversized placement is ignored and never replaced', { skip }, async t => {
  const { path, store } = await fixture(t);
  for (const input of ['{', JSON.stringify({ version: 2, bounds: saved }), JSON.stringify({ version: 1, bounds: { ...saved, x: 9000000 } }), ' '.repeat(4096)]) {
    await writeFile(path, input, { mode: 0o600 });
    assert.equal(await store.read(), undefined);
    assert.equal(await store.save(saved), false);
    assert.equal(await readFile(path, 'utf8'), input);
  }
});

test('links and nonregular or public files cannot become a placement read or write target', { skip }, async t => {
  const { appData, path, store } = await fixture(t);
  const outside = join(appData, 'outside');
  const content = JSON.stringify({ version: 1, bounds: saved });
  await writeFile(outside, content, { mode: 0o600 });
  await symlink(outside, path);
  assert.equal(await store.read(), undefined);
  assert.equal(await store.save(saved), false);
  assert.equal(await readFile(outside, 'utf8'), content);
  await rm(path);
  await link(outside, path);
  assert.equal(await store.read(), undefined);
  assert.equal(await store.save({ ...saved, x: 42 }), false);
  assert.equal(await readFile(path, 'utf8'), content);
  await rm(path);
  await mkdir(path);
  assert.equal(await store.read(), undefined);
  assert.equal(await store.save(saved), false);
  await rm(path, { recursive: true });
  await writeFile(path, content, { mode: 0o644 });
  assert.equal(await store.read(), undefined);
  assert.equal(await store.save(saved), false);
});

test('a symlinked profile is rejected and cannot redirect placement writes', { skip }, async t => {
  const { appData, path, store } = await fixture(t);
  const outside = join(appData, 'elsewhere');
  await mkdir(outside, { mode: 0o700 });
  await rm(profile(appData), { recursive: true });
  await symlink(outside, profile(appData));
  assert.equal(await store.read(), undefined);
  assert.equal(await store.save(saved), false);
  await assert.rejects(stat(path), { code: 'ENOENT' });
});
