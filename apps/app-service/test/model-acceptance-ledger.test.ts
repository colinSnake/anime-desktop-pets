import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ModelAcceptanceLedger, type AcceptancePurpose } from '../src/models/acceptance-ledger.ts';
import { ModelClient } from '../src/models/client.ts';
import { routeFor } from '../src/models/config.ts';
import { configuration } from './fixtures/models.ts';
import { textReply } from './fixtures/model-replies.ts';

const supported = { skip: process.platform === 'win32' };
const fingerprint = 'a'.repeat(64);
const purposes = ['memory.batch', 'expression.reply', 'speech.roundtrip', 'bubble.synthetic'] as const;
const code = (value: string) => ({ name: 'AcceptanceLedgerError', code: value });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pet-model-acceptance-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, guard: join(root, '.model-acceptance.guard'), data: join(root, 'model-acceptance-budget.json'),
    lock: join(root, '.model-acceptance-writer.lock'), ledger: new ModelAcceptanceLedger(root) };
}

test('only explicit approval of the fixed budget plus a selected route can initialize a private ledger', supported, async t => {
  const { root, ledger } = await fixture(t);
  await assert.rejects(ledger.snapshot(), code('not_initialized'));
  await assert.rejects(ledger.withReservation('memory.batch', fingerprint, assert.fail), code('not_initialized'));
  for (const approval of [undefined, 11, 13, '12']) await assert.rejects(ledger.initialize(approval, fingerprint), code('approval_required'));
  await assert.rejects(ledger.initialize(12, 'https://synthetic.invalid'), code('invalid_route'));
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(new ModelAcceptanceLedger(join(root, 'absent')).snapshot(), code('storage_unavailable'));
  assert.deepEqual(await readdir(root), []);
  assert.deepEqual(await ledger.initialize(12, fingerprint), { version: 1, maximumAttempts: 12, reservations: [], remaining: 12 });
  await assert.rejects(ledger.initialize(12, fingerprint), code('ledger_exists'));
  await assert.rejects(ledger.withReservation('SYNTHETIC-CONTENT' as AcceptancePurpose, fingerprint, assert.fail), code('invalid_purpose'));
  await assert.rejects(ledger.withReservation('memory.batch', 'b'.repeat(64), assert.fail), code('route_changed'));
  assert.equal((await ledger.snapshot()).remaining, 12);
});

test('initialization never creates a second budget alongside a legacy ledger and lock', supported, async t => {
  const { root, ledger } = await fixture(t);
  const old = join(root, 'swift-acceptance.json'), oldLock = `${old}.lock`;
  const previous = JSON.stringify({ version: 1, maximumAttempts: 12, reservations: [{ attempt: 1, purpose: 'expression.reply-1-baseline' }] });
  await writeFile(old, previous, { mode: 0o600 });
  await writeFile(oldLock, '', { mode: 0o600 });
  await assert.rejects(ledger.initialize(12, fingerprint), code('ledger_exists'));
  assert.deepEqual((await readdir(root)).sort(), ['swift-acceptance.json', 'swift-acceptance.json.lock']);
  assert.equal(await readFile(old, 'utf8'), previous);
  assert.equal(await readFile(oldLock, 'utf8'), '');
});

test('four purposes share a lifetime cap; a failure or cancellation never refunds and reopening never resets', supported, async t => {
  const { root, data, ledger } = await fixture(t);
  await ledger.initialize(12, fingerprint);
  const failure = Error('SYNTHETIC PROVIDER ERROR'); let calls = 0;
  await assert.rejects(ledger.withReservation(purposes[0], fingerprint, async () => { calls++; throw failure; }), e => e === failure);
  await assert.rejects(ledger.withReservation(purposes[1], fingerprint, async () => { calls++; throw new DOMException('cancelled', 'AbortError'); }), { name: 'AbortError' });
  const reopened = new ModelAcceptanceLedger(root);
  for (let index = 2; index < 12; index++) {
    const purpose = purposes[index % purposes.length]!;
    assert.equal(await reopened.withReservation(purpose, fingerprint, async () => { calls++; return 'private'; }), 'private');
  }
  assert.deepEqual((await reopened.snapshot()).reservations, Array.from({ length: 12 }, (_, index) => ({ attempt: index + 1, purpose: purposes[index % purposes.length] })));
  await assert.rejects(reopened.withReservation('memory.batch', fingerprint, assert.fail), code('exhausted'));
  assert.equal(calls, 12);
  assert.doesNotMatch(await readFile(data, 'utf8'), /SYNTHETIC|private|cancelled|credential|https/);
});

test('instance serialization covers reservations, and operations execute outside the writer lock', supported, async t => {
  const { root, ledger } = await fixture(t);
  await ledger.initialize(12, fingerprint);
  const held = deferred(), entered = deferred();
  const first = ledger.withReservation('memory.batch', fingerprint, async () => { entered.resolve(); await held.promise; });
  try {
    await Promise.race([entered.promise, first]);
    await Promise.all([ledger.withReservation('expression.reply', fingerprint, async () => {}), ledger.withReservation('speech.roundtrip', fingerprint, async () => {})]);
    await new ModelAcceptanceLedger(root).withReservation('bubble.synthetic', fingerprint, async () => {});
    assert.deepEqual((await ledger.snapshot()).reservations.map(r => r.purpose), purposes);
  } finally { held.resolve(); await first; }
});

test('a second writer cannot spend during publication, and a residual lock is never removed or stolen', supported, async t => {
  const { root, ledger, lock } = await fixture(t);
  await ledger.initialize(12, fingerprint);
  const entered = deferred(), release = deferred();
  const writer = new ModelAcceptanceLedger(root, { rename: async (from, to) => { entered.resolve(); await release.promise; await rename(from, to); } });
  const reservation = writer.withReservation('memory.batch', fingerprint, async () => {});
  try {
    await Promise.race([entered.promise, reservation]);
    await assert.rejects(ledger.withReservation('memory.batch', fingerprint, assert.fail), code('busy'));
  } finally { release.resolve(); await reservation; }
  await writeFile(lock, 'other writer', { mode: 0o600 });
  await assert.rejects(ledger.withReservation('memory.batch', fingerprint, assert.fail), code('busy'));
  assert.equal(await readFile(lock, 'utf8'), 'other writer');
});

test('prepublication failure leaves the previous count; unconfirmed directory sync consumes the visible attempt and never dispatches', supported, async t => {
  const { root, ledger, data } = await fixture(t);
  await ledger.initialize(12, fingerprint);
  const before = await readFile(data);
  const unpublished = new ModelAcceptanceLedger(root, { rename: async () => { throw Error('PRIVATE-PATH'); } });
  await assert.rejects(unpublished.withReservation('memory.batch', fingerprint, assert.fail), code('publication_uncertain'));
  assert.deepEqual(await readFile(data), before);
  const uncertain = new ModelAcceptanceLedger(root, { syncPublication: async () => { throw Error('PRIVATE-PATH'); } });
  await assert.rejects(uncertain.withReservation('memory.batch', fingerprint, assert.fail), code('publication_uncertain'));
  await assert.rejects(uncertain.withReservation('bubble.synthetic', fingerprint, assert.fail), code('publication_uncertain'));
  assert.equal((await ledger.snapshot()).remaining, 11);
  assert.equal((await readdir(root)).some(name => name.endsWith('.tmp')), false);
});

for (const change of ['missing ledger', 'missing guard', 'unknown version', 'mismatched run', 'nonsequential', 'unrecognized purpose', 'oversize', 'symlink', 'hardlink', 'directory', 'public mode'] as const) {
  test(`${change}: damaged ledger state cannot be used or initialized again`, supported, async t => {
    const { root, data, guard, ledger } = await fixture(t);
    await ledger.initialize(12, fingerprint);
    if (change === 'missing ledger') await rm(data);
    else if (change === 'missing guard') await rm(guard);
    else if (change === 'oversize') await writeFile(data, ' '.repeat(32769));
    else if (change === 'public mode') await chmod(data, 0o644);
    else if (change === 'directory') { await rm(data); await mkdir(data, { mode: 0o700 }); }
    else if (change === 'symlink') { await rename(data, join(root, 'target')); await symlink(join(root, 'target'), data); }
    else if (change === 'hardlink') await link(data, join(root, 'copy'));
    else {
      const previous = JSON.parse(await readFile(data, 'utf8'));
      if (change === 'unknown version') previous.version = 2;
      if (change === 'mismatched run') previous.runID = '0'.repeat(32);
      if (change === 'nonsequential') previous.reservations = [{ attempt: 2, purpose: 'memory.batch' }];
      if (change === 'unrecognized purpose') previous.reservations = [{ attempt: 1, purpose: 'raw-content' }];
      await writeFile(data, JSON.stringify(previous));
    }
    const reopened = new ModelAcceptanceLedger(root);
    const error = ['oversize', 'symlink', 'hardlink', 'directory', 'public mode'].includes(change) ? 'storage_unavailable' : 'corrupt_ledger';
    await assert.rejects(reopened.snapshot(), code(error));
    await assert.rejects(reopened.initialize(12, fingerprint), code(error));
    await assert.rejects(reopened.withReservation('memory.batch', fingerprint, assert.fail), code(error));
  });
}

test('synthetic transport observes a durable debit and the explicitly authorized route instead of the global default', supported, async t => {
  const { ledger, data, guard } = await fixture(t);
  const state = configuration(), selected = state.connections[0]!;
  const selection = routeFor(state.revision, selected, selected.models[0]!, 'text-chat');
  state.connections.push({ ...selected, id: 'other', baseURL: 'https://other.invalid', credentialRef: 'synthetic-other-reference' });
  state.defaultConnectionID = 'other';
  await ledger.initialize(12, selection.fingerprint);
  let calls = 0, expectedRef = selected.credentialRef;
  const client = new ModelClient({ readConfiguration: () => state, readCredential: async ref => { assert.equal(ref, expectedRef); return 'SYNTHETIC-ACCEPTANCE-KEY'; }, fetch: async (input, request) => {
    calls++;
    assert.equal(String(input), 'https://synthetic.invalid/prefix/v1/chat/completions');
    assert.equal(new Headers(request?.headers).get('authorization'), 'Bearer SYNTHETIC-ACCEPTANCE-KEY');
    assert.deepEqual(JSON.parse(await readFile(data, 'utf8')).reservations, [{ attempt: 1, purpose: 'expression.reply' }]);
    return Response.json(textReply('chat-completions'));
  } });
  const complete = () => client.complete(selection, 'text-chat', { messages: [{ role: 'user', text: 'SYNTHETIC-ACCEPTANCE-PROMPT' }] });
  await ledger.withReservation('expression.reply', selection.fingerprint, complete);
  selected.credentialRef = expectedRef = 'synthetic-rotated-reference';
  const rotated = routeFor(state.revision, selected, selected.models[0]!, 'text-chat');
  await assert.rejects(ledger.withReservation('expression.reply', rotated.fingerprint, assert.fail), code('route_changed'));
  assert.equal(calls, 1);
  assert.doesNotMatch((await readFile(data, 'utf8')) + (await readFile(guard, 'utf8')), /SYNTHETIC|synthetic|credential|https/);
});
