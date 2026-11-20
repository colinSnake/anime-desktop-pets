import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorkspaceDataFolder, workspaceProfilePath } from '../src/workspace-data-folder.ts';

async function fixture(run: (base: string) => Promise<void>) {
  const tmp = await mkdtemp(join(tmpdir(), 'pet-data-folder-'));
  try { await run(await realpath(tmp)); } finally { await rm(tmp, { recursive: true, force: true }); }
}

test('an explicit open targets only the initialized new workspace directory', () => fixture(async base => {
  const opened: string[] = [];
  const handler = new WorkspaceDataFolder(base, async path => { opened.push(path); return ''; });
  const target = join(workspaceProfilePath(base), 'workspace');
  assert.deepEqual(opened, []);
  assert.equal(await handler.open(() => true), 'not-ready');
  await mkdir(target, { recursive: true });
  assert.equal(await handler.open(() => false), 'unavailable');
  assert.deepEqual(opened, []);
  assert.equal(await handler.open(() => true), 'opened');
  assert.deepEqual(opened, [target]);
}));

test('rejects files and linked workspace or profile paths without leaking shell errors', () => fixture(async base => {
  let calls = 0;
  const handler = new WorkspaceDataFolder(base, async () => { calls++; return 'private system path'; });
  const profile = workspaceProfilePath(base);
  const target = join(profile, 'workspace');
  await mkdir(profile, { recursive: true });
  await writeFile(target, 'fixture');
  assert.equal(await handler.open(() => true), 'unavailable');
  await rm(target);
  const other = join(base, 'other');
  await mkdir(other);
  await symlink(other, target, 'junction');
  assert.equal(await handler.open(() => true), 'unavailable');
  await rm(target);
  await rm(profile, { recursive: true });
  await mkdir(join(other, 'workspace'));
  await symlink(other, profile, 'junction');
  assert.equal(await handler.open(() => true), 'unavailable');
  assert.equal(calls, 0);
  await rm(profile);
  await mkdir(target, { recursive: true });
  assert.equal(await handler.open(() => true), 'unavailable');
  assert.equal(calls, 1);
}));

test('cannot reopen after the workspace hides during validation or start a second shell action', () => fixture(async base => {
  await mkdir(join(workspaceProfilePath(base), 'workspace'), { recursive: true });
  let release!: () => void;
  const pending = new Promise<string>(resolve => { release = () => resolve(''); });
  const handler = new WorkspaceDataFolder(base, () => pending);
  let visible = true;
  const first = handler.open(() => visible);
  visible = false;
  assert.equal(await first, 'unavailable');
  const opening = handler.open(() => true);
  assert.equal(await handler.open(() => true), 'busy');
  release();
  assert.equal(await opening, 'opened');
}));
