import assert from 'node:assert/strict';
import test from 'node:test';
import { PetQuota, parseQuotaResult } from '../src/pet-quota.ts';

const balance = { kind: 'balance', amount: 12.5 };

test('quota result admits only numeric subscription windows, USD amounts and fixed failure codes', () => {
  const windows = { kind: 'windows', rows: [{ minutes: 300, remaining: 37.5, resetsAt: 1_800_000_000 }] };
  assert.deepEqual(parseQuotaResult(windows), windows);
  assert.deepEqual(parseQuotaResult(balance), balance);
  for (const value of [
    { ...balance, account: 'private' }, { ...balance, amount: Infinity }, { ...balance, amount: -1 },
    { ...balance, amount: '12.5' }, { kind: 'error', code: 'private provider response' },
    { kind: 'windows', rows: [] }, { ...windows, rows: Array(3).fill(windows.rows[0]) },
    { ...windows, rows: [{ ...windows.rows[0], remaining: 110 }] },
    { ...windows, rows: [{ ...windows.rows[0], resetsAt: 1e20 }] },
  ]) assert.equal(parseQuotaResult(value), undefined);
});

test('quota queries serialize across pets and cancellation suppresses a late result', async () => {
  const calls: AbortSignal[] = [];
  const delivered: unknown[] = [];
  const deliver = (value: unknown) => { delivered.push(value); };
  let complete!: (result: unknown) => void;
  const quota = new PetQuota(signal => {
    calls.push(signal);
    return new Promise(resolve => { complete = resolve; });
  });
  const cancel = quota.request(deliver);
  await Promise.resolve();
  cancel();
  assert.equal(calls[0]?.aborted, true);
  quota.request(deliver);
  assert.deepEqual(delivered, [{ kind: 'error', code: 'busy' }]);
  assert.equal(calls.length, 1);
  complete(balance);
  await new Promise(resolve => setImmediate(resolve));
  quota.request(deliver);
  await Promise.resolve();
  complete(balance);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(delivered, [{ kind: 'error', code: 'busy' }, balance]);
});

test('quota aborts at its deadline and rejects raw failure text', async () => {
  let signal!: AbortSignal;
  let complete!: (result: unknown) => void;
  const quota = new PetQuota(value => {
    signal = value;
    return new Promise(resolve => { complete = resolve; });
  }, 20);
  const result = await new Promise(resolve => { quota.request(resolve); });
  assert.deepEqual(result, { kind: 'error', code: 'timeout' });
  assert.equal(signal.aborted, true);
  complete(balance);
  const invalid = new PetQuota(async () => { throw new Error('private response'); });
  assert.deepEqual(await new Promise(resolve => { invalid.request(resolve); }), { kind: 'error', code: 'unavailable' });
});
