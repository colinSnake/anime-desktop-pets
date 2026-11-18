import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRegistry, defaultPreferences } from '../src/pet-registry.ts';
const pkg = { id: 'local.pet', version: '1.2.3' };
test('legacy registry defaults, stable IDs and size normalization match the old macOS codec', () => {
  const result = decodeRegistry({ schemaVersion: 1, instances: [
    { id: 'old-pet', package: pkg, preferences: { ...defaultPreferences(), size: 96, x: -30, y: 10 } },
    { id: 'old-pet-copy-2', package: pkg },
  ] });
  assert.equal(result.instances[0]!.id, 'old-pet');
  assert.equal(result.instances[0]!.preferences.size, 128);
  assert.equal(result.instances[0]!.preferences.x, -30);
  assert.equal(result.instances[0]!.autoStartOnLaunch, true);
  assert.equal(result.instances[1]!.autoStartOnLaunch, false);
  assert.deepEqual(decodeRegistry(JSON.parse(JSON.stringify(result))), result);
});
test('registry refuses unknown versions, fields, duplicate IDs and invalid preference types', () => {
  const row = { id: 'pet', package: pkg };
  for (const registry of [
    { schemaVersion: 2, instances: [] }, { schemaVersion: 1, instances: [], pid: 2 },
    { schemaVersion: 1, instances: [row, row] },
    { schemaVersion: 1, instances: Array.from({ length: 33 }, (_, i) => ({ ...row, id: `pet-${i}` })) },
    { schemaVersion: 1, instances: [{ ...row, enabled: 1 }] },
    { schemaVersion: 1, instances: [{ ...row, enabled: null }] },
    { schemaVersion: 1, instances: [{ ...row, preferences: { size: 513 } }] },
    { schemaVersion: 1, instances: [{ ...row, preferences: { x: 1 } }] },
    { schemaVersion: 1, instances: [{ ...row, preferences: { run: '/bin/sh' } }] },
  ]) assert.throws(() => decodeRegistry(registry));
});
