import type { SecureCredentialBackend } from '../../src/models/credentials.ts';
/** Synthetic secure-store boundary; never use this in application bootstrap. */
export function syntheticVault() {
  const items = new Map<string, string>();
  const failures = { create: false, read: false, remove: false };
  const backend: SecureCredentialBackend = {
    async create(_service, ref, value) { if (failures.create) throw Error('SYNTHETIC-SECRET'); if (items.has(ref)) throw Error('duplicate'); items.set(ref, value); },
    async read(_service, ref) { if (failures.read) throw Error('SYNTHETIC-SECRET'); return items.get(ref); },
    async remove(_service, ref) { if (failures.remove) throw Error('SYNTHETIC-SECRET'); items.delete(ref); },
  };
  return { backend, items, failures };
}
