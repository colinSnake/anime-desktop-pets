import assert from 'node:assert/strict';
import test from 'node:test';
import { CredentialVault, type SecureCredentialBackend } from '../src/models/credentials.ts';
import { ModelError } from '../src/models/errors.ts';

const code = (expected: string) => (e: unknown) => e instanceof ModelError && e.message === expected && !('cause' in e);
function backend() {
  const items = new Map<string, string>();
  let fail: 'create' | 'read' | 'remove' | undefined;
  const secure: SecureCredentialBackend = {
    async create(service, account, secret) { if (fail === 'create') throw Error('SECRET'); assert.equal(service, 'local.anime-desktop-pets.models.v2'); if (items.has(account)) throw Error('duplicate'); items.set(account, secret); },
    async read(service, account) { assert.equal(service, 'local.anime-desktop-pets.models.v2'); if (fail === 'read') throw Error('SECRET'); return items.get(account); },
    async remove(service, account) { assert.equal(service, 'local.anime-desktop-pets.models.v2'); if (fail === 'remove') throw Error('SECRET'); items.delete(account); },
  };
  return { secure, items, fail(value: typeof fail) { fail = value; } };
}
const signal = () => new AbortController().signal;
test('immutable independent versions survive replacement; reading a snapshot never follows a connection alias', async () => {
  const b = backend(), vault = new CredentialVault(b.secure);
  const one = await vault.prepare('a', 'SYNTHETIC-ONE'), two = await vault.prepare('a', 'SYNTHETIC-TWO'), other = await vault.prepare('b', 'SYNTHETIC-OTHER');
  assert.notEqual(one.ref, two.ref); assert.notEqual(one.ref, other.ref);
  assert.doesNotMatch(JSON.stringify([one, two, other]), /SYNTHETIC/);
  assert.equal(await vault.read(one.ref, signal()), 'SYNTHETIC-ONE');
  assert.equal(await vault.read(two.ref, signal()), 'SYNTHETIC-TWO');
  assert.equal(await vault.read(other.ref, signal()), 'SYNTHETIC-OTHER');
  const reopened = new CredentialVault(b.secure); assert.equal(await reopened.read(one.ref, signal()), 'SYNTHETIC-ONE');
});
test('unavailable backend and secret-bearing backend failures become fixed credential errors', async () => {
  await assert.rejects(new CredentialVault().prepare('a', 'SYNTHETIC'), code('credentials_unavailable'));
  const b = backend(), vault = new CredentialVault(b.secure), item = await vault.prepare('a', 'SYNTHETIC');
  b.fail('create'); await assert.rejects(vault.prepare('a', 'SYNTHETIC-NEW'), code('credentials_unavailable'));
  b.fail('read'); await assert.rejects(vault.read(item.ref, signal()), code('credentials_unavailable'));
  b.fail('remove'); assert.equal(await vault.discard(item), false); assert.equal(b.items.size, 1);
});
test('only an owned unpublished preparation can be discarded; no arbitrary ref or foreign handle deletion', async () => {
  const b = backend(), vault = new CredentialVault(b.secure), other = new CredentialVault(b.secure);
  const published = await vault.prepare('a', 'SYNTHETIC-OLD'), pending = await vault.prepare('a', 'SYNTHETIC-NEW');
  vault.publish(published);
  assert.equal(await vault.discard(published), false);
  assert.equal(await vault.discard({ ref: pending.ref }), false);
  assert.equal(await other.discard(pending), false);
  assert.equal(await vault.discard(pending), true); assert.equal(await vault.discard(pending), false);
  assert.equal(await vault.read(published.ref, signal()), 'SYNTHETIC-OLD');
  assert.equal(await vault.read(pending.ref, signal()), undefined);
});
test('invalid keys/connection IDs/ref namespaces never reach the backend; cancellation suppresses a late key', async () => {
  const b = backend(), vault = new CredentialVault(b.secure);
  for (const key of ['', ' ', 'x\ny', 'x'.repeat(8193), '密钥']) await assert.rejects(vault.prepare('a', key), code('credentials_unavailable'));
  await assert.rejects(vault.prepare('../escape', 'SYNTHETIC'), code('credentials_unavailable')); assert.equal(b.items.size, 0);
  await assert.rejects(vault.read('another-application-item', signal()), code('credentials_unavailable'));
  const item = await vault.prepare('a', 'SYNTHETIC'), controller = new AbortController(); controller.abort();
  await assert.rejects(vault.read(item.ref, controller.signal), code('cancelled'));
  let release!: (key: string) => void;
  const late = new CredentialVault({ ...b.secure, read: () => new Promise<string>(r => { release = r; }) });
  const c = new AbortController(), pending = late.read(item.ref, c.signal); c.abort(); release('SYNTHETIC');
  await assert.rejects(pending, code('cancelled'));
});
test('tampered backend payload cannot bind a credential version to a different item', async () => {
  const b = backend(), vault = new CredentialVault(b.secure);
  const a = await vault.prepare('a', 'SYNTHETIC-A'), other = await vault.prepare('b', 'SYNTHETIC-B');
  b.items.set(a.ref, b.items.get(other.ref)!);
  await assert.rejects(vault.read(a.ref, signal()), code('credentials_unavailable'));
});
