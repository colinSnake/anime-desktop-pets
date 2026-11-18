import assert from 'node:assert/strict';
import test from 'node:test';
import { PetPackageImporter } from '../src/pet-package-importer.ts';

test('package importer scans only its managed packages directory and strips paths from catalog data', async () => {
 const requests: Record<string, unknown>[] = [];
 const importer = new PetPackageImporter({ root: '/workspace', scriptPath: '/trusted/pet_sources.py', invoke: async request => {
  requests.push(request);
  return { ok: true, pets: [{ id: 'vendor.pet', version: '1.2.0', name: '小角色', path: '/private/workspace/pet-library/packages/vendor.pet/1.2.0' }] };
 } });
 assert.deepEqual(await importer.listCatalog(), [{ id: 'vendor.pet', version: '1.2.0', name: '小角色', launchable: false }]);
 assert.deepEqual(requests, [{ operation: 'scan', paths: ['/workspace/pet-library/packages'] }]);
});

test('package importer accepts one validated identity and never returns the selected source path', async () => {
 const requests: Record<string, unknown>[] = [];
 const importer = new PetPackageImporter({ root: '/workspace', scriptPath: '/trusted/pet_sources.py', invoke: async request => {
  requests.push(request);
  if (request.operation === 'prepare') return { ok: true, packages: [{ id: 'vendor.pet', version: '1.2.0' }] };
  return { ok: true, pets: [{ id: 'vendor.pet', version: '1.2.0', name: '小角色', path: '/workspace/private' }] };
 } });
 const result = await importer.importOne('/Users/test/小角色.petpack');
 assert.deepEqual(result, { name: '小角色.petpack', package: { id: 'vendor.pet', version: '1.2.0', name: '小角色', launchable: false } });
 assert.deepEqual(requests[0], { operation: 'prepare', paths: ['/Users/test/小角色.petpack'], library: '/workspace/pet-library' });
 assert.doesNotMatch(JSON.stringify(result), /Users\/test|workspace/);
});

test('package importer rejects malformed identities and unsafe tool paths', async () => {
 const importer = new PetPackageImporter({ root: '/workspace', scriptPath: '/trusted/pet_sources.py', invoke: async () => ({ ok: true, packages: [{ id: '../escape', version: '1.0.0' }] }) });
 await assert.rejects(importer.importOne('/selected/pet.petpack'));
 assert.throws(() => new PetPackageImporter({ root: 'relative', scriptPath: '/trusted/pet_sources.py' }));
});
