import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { LegacyCharacterHandoff } from '../src/legacy-character-handoff.ts';
import type { LegacyHandoffWrite } from '../src/character-transport.ts';
import { inspectLegacyCharacterSnapshot } from '../src/legacy-character-snapshot.ts';

const windows = process.platform === 'win32';
const stamp = '2026-11-18T00:00:00Z';
const id = 'c015a3d1-25c1-41d7-bdbc-a3ac4cab2547';
const doc = (meta: object, body: string) => `---\n${JSON.stringify(meta)}\n---\n\n${body}\n`;
const identity = doc({ schema: 1, shareWithOnlineModel: true }, '# 私有身份正文');
const memory = doc({ schema: 1, id, kind: '事实', createdAt: stamp, source: '合成', status: 'confirmed', shareWithOnlineModel: true }, '私有记忆正文');
const goal = doc({ schema: 2, id, createdAt: stamp, status: '进行中', shareWithOnlineModel: true }, '# 私有目标正文');
async function fixture(t: TestContext) {
  const sandbox = await mkdtemp(join(tmpdir(), 'pet-legacy-snapshot-'));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const snapshot = join(sandbox, '用户选择的离线快照'), appData = join(sandbox, 'Application Support');
  await Promise.all([mkdir(join(snapshot, 'memories'), { recursive: true }), mkdir(join(snapshot, 'plans'), { recursive: true }), mkdir(appData)]);
  return { sandbox, snapshot, appData, inspect: (path = snapshot) => inspectLegacyCharacterSnapshot(path, appData, stamp) };
}

test('summarizes only the selected character snapshot and never returns or writes record data', async t => {
  const { snapshot, inspect } = await fixture(t);
  const valid = join(snapshot, 'identity.md');
  await Promise.all([
    writeFile(valid, identity),
    writeFile(join(snapshot, 'memories', `${id}.md`), memory),
    writeFile(join(snapshot, 'memories', 'broken.md'), 'invalid'),
    writeFile(join(snapshot, 'plans', `${id}.md`), goal),
    mkdir(join(snapshot, 'memory-history')),
    writeFile(join(snapshot, 'model-provider.json'), 'ignored configuration'),
    writeFile(join(snapshot, 'memories', 'attachment.txt'), 'ignored attachment'),
  ]);
  await writeFile(join(snapshot, 'memory-history', `${id}.md`), Buffer.alloc(64 * 1024 + 1));
  assert.deepEqual(await inspect(), { ok: true, report: {
    identity: 'recognized', memories: { recognized: 1, invalid: 1 }, goals: { recognized: 1, invalid: 0 },
  } });
  assert.equal(await readFile(valid, 'utf8'), identity);
  assert.equal(await readFile(join(snapshot, 'memories', `${id}.md`), 'utf8'), memory);
});

test('distinguishes an empty snapshot, a missing identity and an unsupported version', async t => {
  const { snapshot, inspect } = await fixture(t);
  assert.deepEqual(await inspect(), { ok: false, error: 'empty' });
  await writeFile(join(snapshot, 'plans', `${id}.md`), goal);
  assert.deepEqual(await inspect(), { ok: true, report: {
    identity: 'missing', memories: { recognized: 0, invalid: 0 }, goals: { recognized: 1, invalid: 0 },
  } });
  await writeFile(join(snapshot, 'identity.md'), doc({ schema: 99, shareWithOnlineModel: false }, '# 不支持'));
  const result = await inspect();
  assert.equal(result.ok && result.report.identity, 'invalid');
});

test('rejects active application storage, symbolic links, hard links and special files', async t => {
  const { sandbox, appData, snapshot, inspect } = await fixture(t);
  const file = join(snapshot, 'identity.md'), target = join(sandbox, 'outside.md');
  const live = join(appData, 'AnimeDesktopPets', 'pets', 'bailong', 'character');
  const alias = join(sandbox, 'snapshot-alias');
  await mkdir(live, { recursive: true });
  await writeFile(join(live, 'identity.md'), identity);
  await writeFile(target, identity);
  await symlink(snapshot, alias, windows ? 'junction' : 'dir');
  if (windows) await mkdir(file);
  else await symlink(target, file);
  for (const path of [live, alias, snapshot, 'relative', `${snapshot}/../${basename(snapshot)}`]) {
    assert.deepEqual(await inspect(path), { ok: false, error: 'unsafe' });
  }
  await rm(file, { recursive: true });
  await link(target, file);
  assert.deepEqual(await inspect(), { ok: false, error: 'unsafe' });
  await rm(file);
  if (!windows) {
    execFileSync('mkfifo', [file]);
    assert.deepEqual(await inspect(), { ok: false, error: 'unsafe' });
    await rm(file);
  }
  await rm(join(snapshot, 'plans'), { recursive: true });
  await symlink(sandbox, join(snapshot, 'plans'), windows ? 'junction' : 'dir');
  assert.deepEqual(await inspect(), { ok: false, error: 'unsafe' });
});

test('enforces individual, total and directory budgets without returning partial counts', async t => {
  const { snapshot, inspect } = await fixture(t);
  const file = join(snapshot, 'identity.md'), oversized = Buffer.alloc(64 * 1024 + 1);
  await writeFile(file, oversized);
  assert.deepEqual(await inspect(), { ok: false, error: 'limit' });
  await rm(file);
  const each = Buffer.alloc(64 * 1024, 120);
  for (let i = 0; i < 65; i++) await writeFile(join(snapshot, 'memories', `${i.toString(16).padStart(32, '0')}.md`), each);
  assert.deepEqual(await inspect(), { ok: false, error: 'limit' });
  await rm(join(snapshot, 'memories'), { recursive: true });
  await mkdir(join(snapshot, 'memories'));
  for (let i = 0; i < 129; i++) await writeFile(join(snapshot, 'memories', `${i}.md`), '');
  assert.deepEqual(await inspect(), { ok: false, error: 'limit' });
  for (let i = 0; i < 129; i++) await rm(join(snapshot, 'memories', `${i}.md`));
  for (let i = 0; i < 257; i++) await writeFile(join(snapshot, 'memories', `${i}.txt`), '');
  assert.deepEqual(await inspect(), { ok: false, error: 'limit' });
});

test('a changed file cannot be exposed as a stable snapshot, and the next selection may retry', async t => {
  const { snapshot, appData } = await fixture(t);
  const file = join(snapshot, 'identity.md');
  await writeFile(file, identity);
  let checked = 0;
  const inspect = (current: () => boolean) => inspectLegacyCharacterSnapshot(snapshot, appData, stamp, current);
  const changed = await inspect(() => {
    if (++checked === 2) writeFileSync(file, identity.replace('私有身份正文', '不同版本身份'));
    return true;
  });
  assert.deepEqual(changed, { ok: false, error: 'changed' });
  assert.equal((await inspect(() => true)).ok, true);
});

test('the native selection is explicit, single-flight and discarded after the window lease ends', async t => {
  const { appData, snapshot } = await fixture(t);
  await writeFile(join(snapshot, 'identity.md'), identity);
  const handoff = new LegacyCharacterHandoff(appData, async () => ({ ok: true, status: { revision: 0, mode: 'empty' } }));
  t.after(() => handoff.invalidate());
  const select = (choose: Parameters<typeof handoff.handle>[1]) => handoff.handle({ action: 'select', petID: 'development-1' }, choose, current);
  const selected = { canceled: false, filePaths: [snapshot] };
  let eligible = true;
  const current = () => eligible;
  let finish!: (selection: typeof selected) => void;
  const pending = select(() => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  assert.deepEqual(await select(async () => assert.fail('must not open another picker')), { ok: false, error: 'busy' });
  eligible = false;
  finish(selected);
  assert.deepEqual(await pending, { ok: false, error: 'unavailable' });
  assert.deepEqual(await select(async () => assert.fail('must not open for an inactive caller')), { ok: false, error: 'unavailable' });
  eligible = true;
  assert.deepEqual(await select(async () => ({ canceled: true, filePaths: [] })), { ok: false, error: 'cancelled' });
  assert.deepEqual(await select(async () => ({ canceled: false, filePaths: [snapshot, snapshot] })), { ok: false, error: 'unsafe' });
  assert.equal((await select(async () => selected)).ok, true);
});

test('handoff stages only one validated batch, strips old metadata and consumes the ticket once for the bound target revision', async t => {
  const { appData, snapshot } = await fixture(t);
  const file = join(snapshot, 'identity.md');
  await writeFile(file, identity);
  await writeFile(join(snapshot, 'memories', `${id}.md`), memory);
  await writeFile(join(snapshot, 'plans', `${id}.md`), goal);
  const writes: Array<{ petID: string; write: LegacyHandoffWrite }> = [];
  const transfer = new LegacyCharacterHandoff(appData, async (petID, write) => {
    if (write) writes.push({ petID, write });
    return { ok: true, status: { revision: write ? 8 : 7, mode: write ? 'undoable' : 'empty' } };
  });
  t.after(() => transfer.invalidate());
  const choose = async () => ({ canceled: false, filePaths: [snapshot] });
  const petID = 'development-1', select = { action: 'select', petID };
  assert.deepEqual(await transfer.handle({ ...select, path: snapshot }, async () => assert.fail('renderer path must be refused'), () => true), { ok: false, error: 'invalid' });
  const preview = await transfer.handle(select, choose, () => true);
  assert.ok(preview.ok && 'report' in preview && preview.ticket);
  assert.doesNotMatch(JSON.stringify(preview), /私有|分享|character|\.md/);
  assert.equal(writes.length, 0);
  // A staged draft represents exactly the bytes that were previewed, without re-opening paths on commit.
  await writeFile(file, identity.replace('私有身份正文', '之后变更'));
  const confirm = { action: 'import', petID, ticket: preview.ticket };
  const noPicker = async () => assert.fail('commit cannot open a picker');
  assert.deepEqual(await transfer.handle({ ...confirm, petID: 'development-2' }, noPicker, () => true), { ok: false, error: 'conflict' });
  assert.equal((await transfer.handle(confirm, noPicker, () => true)).ok, true);
  assert.equal(writes.length, 1);
  const sent = writes[0]!;
  assert.equal(sent.petID, petID);
  assert.equal(sent.write.expectedRevision, 7);
  assert.equal(sent.write.command.type, 'importLegacy');
  assert.equal(sent.write.command.value.identity?.name, '私有身份正文');
  assert.doesNotMatch(JSON.stringify(sent), /chatShare|recordedShare|confirmedAt|sourceSchema|\.md|之后变更/);
  assert.deepEqual(await transfer.handle(confirm, noPicker, () => true), { ok: false, error: 'conflict' });
  assert.equal(writes.length, 1);
});

test('handoff refuses partial import and invalidates a previous report after cancellation, window loss or expiry', async t => {
  const { appData, snapshot } = await fixture(t);
  await writeFile(join(snapshot, 'identity.md'), identity);
  const broken = join(snapshot, 'memories', `${id}.md`);
  await writeFile(broken, memory.replace('私有记忆正文', 'API key 示例'));
  const transfer = new LegacyCharacterHandoff(appData, async (_id, write) => {
    assert.equal(write, undefined, 'no write from stale or invalid previews');
    return { ok: true, status: { revision: 0, mode: 'empty' } };
  }, 400);
  t.after(() => transfer.invalidate());
  const choose = async () => ({ canceled: false, filePaths: [snapshot] });
  const petID = 'development-1', current = () => true;
  const select = () => transfer.handle({ action: 'select', petID }, choose, current);
  const bad = await select();
  assert.ok(bad.ok && 'report' in bad && bad.report.memories.invalid === 1 && !bad.ticket);
  await rm(broken);
  for (const invalidate of [
    () => transfer.handle({ action: 'select', petID }, async () => ({ canceled: true, filePaths: [] }), current),
    () => transfer.invalidate(),
    () => new Promise(resolve => setTimeout(resolve, 410)),
  ]) {
    const preview = await select();
    assert.ok(preview.ok && 'report' in preview && preview.ticket);
    await invalidate();
    assert.deepEqual(await transfer.handle({ action: 'import', petID, ticket: preview.ticket }, choose, current), { ok: false, error: 'conflict' });
  }
});
