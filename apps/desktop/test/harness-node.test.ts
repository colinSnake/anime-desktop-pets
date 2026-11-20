import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveHarnessExecutable } from '../src/harness-node.ts';

test('packaged macOS resolves the bundled standalone Node and ignores development overrides', () => {
  assert.equal(resolveHarnessExecutable({
    platform: 'darwin', packaged: true, resourcesPath: '/tmp/Anime Desktop Pets.app/Contents/Resources',
    environment: { PET_HARNESS_NODE: '/tmp/foreign-node' },
  }), '/tmp/Anime Desktop Pets.app/Contents/Helpers/pet-harness-node');
});

test('development macOS accepts only an absolute standalone Node override', () => {
  assert.equal(resolveHarnessExecutable({
    platform: 'darwin', packaged: false, resourcesPath: '/tmp/resources',
    environment: { PET_HARNESS_NODE: '/usr/local/bin/node' },
  }), '/usr/local/bin/node');
  assert.equal(resolveHarnessExecutable({
    platform: 'darwin', packaged: false, resourcesPath: '/tmp/resources',
    environment: { PET_HARNESS_NODE: 'node' },
  }), undefined);
});

test('non-macOS, invalid resource roots, and invalid overrides do not select an executable', () => {
  assert.equal(resolveHarnessExecutable({ platform: 'linux', packaged: true, resourcesPath: '/tmp/resources', environment: { PET_HARNESS_NODE: '/usr/local/bin/node' } }), undefined);
  for (const value of [undefined, '/tmp/node\0', `/tmp/${'中'.repeat(1500)}`]) {
    assert.equal(resolveHarnessExecutable({ platform: 'darwin', packaged: false, resourcesPath: '/tmp/resources', environment: { PET_HARNESS_NODE: value } }), undefined);
  }
  assert.equal(resolveHarnessExecutable({ platform: 'darwin', packaged: true, resourcesPath: 'Resources', environment: { PET_HARNESS_NODE: '/tmp/foreign-node' } }), undefined);
});
