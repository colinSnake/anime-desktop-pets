import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewQuota, createPreviewQuotaSource } from '../src/video-preview/quota.ts';
import type { PreviewQuotaState } from '../src/video-preview/bridge.ts';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test('quota holds one native query across video windows and cancels without showing a late response', async () => {
  const loads: { signal: AbortSignal; resolve: (value: unknown) => void }[] = [];
  const source = createPreviewQuotaSource('/unused', signal => new Promise(resolve => loads.push({ signal, resolve })));
  const first: PreviewQuotaState[] = [], second: PreviewQuotaState[] = [];
  const a = createPreviewQuota(source, value => first.push(value));
  const b = createPreviewQuota(source, value => second.push(value));
  b.refresh(); assert.equal(second.length, 0);
  a.request(); a.request(); await turn();
  assert.equal(loads.length, 1);
  b.request();
  assert.equal(second.at(-1)?.kind, 'error');
  a.close();
  assert.equal(loads[0]!.signal.aborted, true);
  let drained = false;
  void source.drain().then(() => { drained = true; });
  await turn(); assert.equal(drained, false);
  b.refresh(); assert.equal(loads.length, 1);
  loads[0]!.resolve({ kind: 'balance', amount: 10, currency: 'USD' });
  await turn(); assert.equal(drained, true);
  assert.deepEqual(first, [{ kind: 'loading' }, { kind: 'closed' }]);
  b.refresh(); await turn();
  loads[1]!.resolve({ kind: 'balance', amount: 2, currency: 'USD' });
  await turn(); assert.equal(second.at(-1)?.kind, 'balance');
  assert.deepEqual(first, [{ kind: 'loading' }, { kind: 'closed' }]);
});
