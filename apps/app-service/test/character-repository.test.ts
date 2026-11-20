import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { CharacterRepository } from '../src/characters/repository.ts';

const pet = 'development-1', other = 'development-2';
const a = '2026-11-18T10:00:00.000Z', b = '2026-11-18T10:15:00.000Z';
const identity = (name: string) => ({ name, role: '伙伴', background: '', personality: '', values: '', motivations: '', relationship: '', speakingStyle: '', knowledgeScope: '', boundaries: '' });
const knowledge = (text: string) => ({ kind: '知识', text, source: '测试手册', citation: '章节一', version: 'v1', expiresAt: b } as const);
const goal = (text: string) => ({ title: '整理公开示例', details: '', status: '进行中', steps: [{ text, isComplete: false }] } as const);
const posix = { skip: process.platform === 'win32' };
async function fixture(t: TestContext, io?: NonNullable<ConstructorParameters<typeof CharacterRepository>[1]>['io']) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'adp-character-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let time = a;
  const open = () => new CharacterRepository(root, { clock: () => new Date(time), io });
  return { root, file: join(root, `${pet}.json`), repo: open(), open, setTime: (value: string) => { time = value; } };
}
const code = (message: string) => ({ message });

test('identity keeps an isolated revision trail and restores as a fresh local version', posix, async t => {
  const { repo, open, root, file, setTime } = await fixture(t);
  assert.equal((await repo.read(pet)).identity, null);
  await repo.apply(pet, 0, { type: 'saveIdentity', value: identity('初稿') });
  setTime(b);
  await repo.apply(pet, 1, { type: 'saveIdentity', value: identity('新版') });
  const result = await repo.apply(pet, 2, { type: 'restoreIdentity', revision: 1 });
  assert.equal(result.durability, 'confirmed');
  assert.deepEqual(result.state.identity, { ...identity('初稿'), revision: 3, createdAt: a, updatedAt: b });
  assert.deepEqual(result.state.identityHistory.map(i => i.name), ['初稿', '新版']);
  assert.deepEqual(await open().read(pet), result.state);
  assert.equal((await open().read(other)).identity, null);
  assert.equal((await lstat(root)).mode & 0o777, 0o700);
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
});

test('memory edit, restore, and withdrawal cannot carry a prior confirmation', posix, async t => {
  const { repo } = await fixture(t);
  const created = await repo.apply(pet, 0, { type: 'addMemory', value: knowledge('第一版') });
  const id = created.state.memories[0]!.current.id;
  assert.equal(created.state.memories[0]!.current.status, 'candidate');
  assert.equal((await repo.apply(pet, 1, { type: 'confirmMemory', id })).state.memories[0]!.current.confirmedAt, a);
  const revised = await repo.apply(pet, 2, { type: 'editMemory', id, value: knowledge('第二版') });
  assert.equal(revised.state.memories[0]!.current.status, 'candidate');
  assert.equal(revised.state.memories[0]!.current.confirmedAt, undefined);
  await repo.apply(pet, 3, { type: 'confirmMemory', id });
  const withdrawn = await repo.apply(pet, 4, { type: 'withdrawMemory', id });
  assert.equal(withdrawn.state.memories[0]!.current.status, 'candidate');
  const restored = await repo.apply(pet, 5, { type: 'restoreMemory', id, revision: 1 });
  assert.deepEqual(restored.state.memories[0]!.current, { ...knowledge('第一版'), id, createdAt: a, updatedAt: a, revision: 3, status: 'candidate' });
  const deleted = await repo.apply(pet, 6, { type: 'deleteMemory', id });
  assert.deepEqual(deleted.state.memories, []);
});

test('memory rejects expired, duplicate, conflicting, or credential-like data without bumping revision', posix, async t => {
  const { repo, file, setTime } = await fixture(t);
  const one = (await repo.apply(pet, 0, { type: 'addMemory', value: knowledge('公开设置 A') })).state.memories[0]!.current.id;
  await repo.apply(pet, 1, { type: 'confirmMemory', id: one });
  const two = (await repo.apply(pet, 2, { type: 'addMemory', value: knowledge('公开设置 B') })).state.memories[1]!.current.id;
  await assert.rejects(repo.apply(pet, 3, { type: 'confirmMemory', id: two }), code('knowledge_conflict'));
  const three = (await repo.apply(pet, 3, { type: 'addMemory', value: knowledge(' 公开设置 A ') })).state.memories[2]!.current.id;
  await assert.rejects(repo.apply(pet, 4, { type: 'confirmMemory', id: three }), code('memory_duplicate'));
  setTime(b);
  await assert.rejects(repo.apply(pet, 4, { type: 'confirmMemory', id: two }), code('memory_expired'));
  const before = await readFile(file);
  for (const patch of [{ text: '访问密码 sample' }, { source: 'AＰＩ＿Ｋｅｙ sample' }, { citation: 'Bearer synthetic-value' }, { version: 'token sample' }]) {
    await assert.rejects(repo.apply(pet, 4, { type: 'addMemory', value: { ...knowledge('内容'), ...patch } }), code('credential_like_memory'));
  }
  await assert.rejects(repo.apply(pet, 4, { type: 'addMemory', value: { ...knowledge('内容'), shareWithOnlineModel: true } }), code('invalid_character_data'));
  assert.deepEqual(await readFile(file), before);
});

test('goals keep service-issued step IDs and cannot mutate another role', posix, async t => {
  const { repo } = await fixture(t);
  const created = (await repo.apply(pet, 0, { type: 'addGoal', value: goal('第一步') })).state.goals[0]!;
  const step = created.steps[0]!;
  await assert.rejects(repo.apply(other, 0, { type: 'editGoal', id: created.id, value: goal('跨角色') }), code('character_record_not_found'));
  const edited = (await repo.apply(pet, 1, { type: 'editGoal', id: created.id, value: { ...goal('忽略'), status: '已完成', steps: [{ ...step, isComplete: true }, { text: '补充', isComplete: false }] } })).state.goals[0]!;
  assert.equal(edited.steps.length, 2);
  assert.deepEqual(edited.steps[0], { ...step, isComplete: true });
  assert.notEqual(edited.steps[1]!.id, step.id);
  await assert.rejects(repo.apply(pet, 2, { type: 'editGoal', id: created.id, value: { ...goal('忽略'), steps: [step, step] } }), code('invalid_character_data'));
  assert.deepEqual((await repo.apply(pet, 2, { type: 'deleteGoal', id: created.id })).state.goals, []);
});

test('stale revisions and concurrent stores cannot overwrite an acknowledged save', posix, async t => {
  const { repo, open } = await fixture(t);
  const second = open();
  const results = await Promise.allSettled([repo.apply(pet, 0, { type: 'saveIdentity', value: identity('甲') }), second.apply(pet, 0, { type: 'saveIdentity', value: identity('乙') })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const denied = results.find(result => result.status === 'rejected');
  assert.match(denied?.reason.message, /^character_(busy|conflict)$/);
  await assert.rejects(second.apply(pet, 0, { type: 'saveIdentity', value: identity('丙') }), code('character_conflict'));
  assert.equal((await repo.read(pet)).revision, 1);
});

test('invalid path, links, public files, oversized and unsupported documents never get replaced', posix, async t => {
  const { repo, open, root, file } = await fixture(t);
  await assert.rejects(repo.read('../legacy'), code('invalid_character_data'));
  const target = join(root, 'unchanged');
  await writeFile(target, 'private fixture', { mode: 0o600 });
  await symlink(target, file);
  const update = (store = open()) => store.apply(pet, 0, { type: 'saveIdentity', value: identity('不应写入') });
  await assert.rejects(update(), code('character_storage_unavailable'));
  assert.equal(await readFile(target, 'utf8'), 'private fixture');
  await rm(file);
  await mkdir(file, { mode: 0o700 });
  await assert.rejects(update(), code('character_storage_unavailable'));
  await rm(file, { recursive: true });
  for (const bytes of ['{', '{"schemaVersion":99}', Buffer.alloc(1_048_577), Buffer.from([0xff])]) {
    await writeFile(file, bytes, { mode: 0o600 });
    await assert.rejects(update(), code('character_storage_unavailable'));
    assert.deepEqual(await readFile(file), Buffer.from(bytes));
  }
  await rm(file);
  await repo.apply(pet, 0, { type: 'saveIdentity', value: identity('持久资料') });
  await chmod(file, 0o644);
  await assert.rejects(repo.read(pet), code('character_storage_unavailable'));
  await rm(file);
  await assert.rejects(update(repo), code('character_storage_unavailable'));
});

test('failed rename keeps old bytes; directory sync failure cannot imply rollback', posix, async t => {
  let fail: 'rename' | 'sync' | undefined;
  const { repo, file, open } = await fixture(t, {
    rename: async (from, to) => { if (fail === 'rename') throw new Error('synthetic private path'); await rename(from, to); },
    syncDirectory: async () => { if (fail === 'sync') throw new Error('synthetic private path'); },
  });
  const write = (expected: number, name: string) => repo.apply(pet, expected, { type: 'saveIdentity', value: identity(name) });
  await write(0, '原版');
  const before = await readFile(file);
  fail = 'rename';
  await assert.rejects(write(1, '失败'), code('character_storage_unavailable'));
  assert.deepEqual(await readFile(file), before);
  fail = 'sync';
  assert.equal((await write(1, '已发布')).durability, 'unconfirmed');
  assert.equal((await open().read(pet)).identity?.name, '已发布');
});

test('resaving identical drafts does not consume history or withdraw a confirmed memory', posix, async t => {
  const { repo, file } = await fixture(t);
  await repo.apply(pet, 0, { type: 'saveIdentity', value: identity(' 角色 ') });
  const { state: added } = await repo.apply(pet, 1, { type: 'addMemory', value: knowledge('相同内容') });
  const id = added.memories[0]!.current.id;
  const { state: confirmed } = await repo.apply(pet, 2, { type: 'confirmMemory', id });
  const before = await readFile(file);
  const { state } = await repo.apply(pet, 3, { type: 'editMemory', id, value: knowledge('相同内容') });
  assert.deepEqual(state, confirmed);
  assert.deepEqual((await repo.apply(pet, 3, { type: 'saveIdentity', value: identity('角色') })).state, confirmed);
  assert.equal(state.identity?.name, '角色');
  assert.deepEqual(await readFile(file), before);
});

test('restored and copied data must be canonical and belong to the requested pet', posix, async t => {
  const { repo, open, file, root } = await fixture(t);
  await repo.apply(pet, 0, { type: 'saveIdentity', value: identity('原角色') });
  const valid = await readFile(file, 'utf8');
  const duplicate = valid.replace('"schemaVersion":1', '"schemaVersion":99,"schemaVersion":1');
  await writeFile(file, duplicate);
  await assert.rejects(open().read(pet), code('character_storage_unavailable'));
  await writeFile(join(root, `${other}.json`), valid, { mode: 0o600 });
  await assert.rejects(open().read(other), code('character_storage_unavailable'));
});

test('renamed-but-unacknowledged commits are reconciled and unknown outcomes stop writes', posix, async t => {
  let disposition: 'late-success' | 'ambiguous' | undefined;
  const { repo, open } = await fixture(t, {
    rename: async (from, to) => {
      if (disposition === 'ambiguous') { await writeFile(to, '{'); throw new Error('unknown publish result'); }
      await rename(from, to);
      if (disposition === 'late-success') throw new Error('lost acknowledgement');
    },
  });
  const save = (n: number, name: string) => repo.apply(pet, n, { type: 'saveIdentity', value: identity(name) });
  await save(0, '已存在');
  disposition = 'late-success';
  assert.equal((await save(1, '迟到确认')).durability, 'unconfirmed');
  assert.equal((await open().read(pet)).identity?.name, '迟到确认');
  disposition = 'ambiguous';
  await assert.rejects(save(2, '未知结果'), code('character_publication_uncertain'));
  disposition = undefined;
  await assert.rejects(save(2, '不能重试'), code('character_publication_uncertain'));
  await assert.rejects(repo.read(pet), code('character_storage_unavailable'));
  assert.equal((await repo.apply(other, 0, { type: 'saveIdentity', value: identity('仍可写入') })).state.revision, 1);
});

test('bounded history and serialized bytes protect an existing snapshot', posix, async t => {
  const { repo, file } = await fixture(t);
  for (let revision = 0; revision < 8; revision++) {
    await repo.apply(pet, revision, { type: 'saveIdentity', value: identity(`版本 ${revision}`) });
  }
  assert.deepEqual((await repo.read(pet)).identityHistory.map(row => row.revision), [3, 4, 5, 6, 7]);
  await assert.rejects(repo.apply(pet, 8, { type: 'restoreIdentity', revision: 2 }), code('character_record_not_found'));
  // Each value fits the grapheme limits independently; retaining several of
  // them must still fit the serialized snapshot's byte limit.
  const long = ('a' + '\u0301'.repeat(15)).repeat(1975);
  const draft = { ...identity('大资料'), role: long, background: long, personality: long, values: long };
  for (let revision = 8; revision < 12; revision++) {
    await repo.apply(pet, revision, { type: 'saveIdentity', value: { ...draft, name: `${draft.name}${revision}` } });
  }
  const before = await readFile(file);
  await assert.rejects(repo.apply(pet, 12, { type: 'saveIdentity', value: draft }), code('character_limit'));
  assert.deepEqual(await readFile(file), before);
});

test('standalone credential-shaped strings are blocked in every memory field', posix, async t => {
  const { repo } = await fixture(t);
  const synthetic = 'AIza' + 'x'.repeat(35);
  for (const key of ['text', 'source', 'citation', 'version'] as const) {
    await assert.rejects(repo.apply(pet, 0, { type: 'addMemory', value: { ...knowledge('示例'), [key]: synthetic } }), code('credential_like_memory'));
  }
  assert.deepEqual((await repo.read(pet)).memories, []);
});

test('invisible formatting cannot turn one knowledge reference into two', posix, async t => {
  const { repo } = await fixture(t);
  const first = (await repo.apply(pet, 0, { type: 'addMemory', value: knowledge('设定甲') })).state.memories[0]!.current;
  await repo.apply(pet, 1, { type: 'confirmMemory', id: first.id });
  const second = (await repo.apply(pet, 2, { type: 'addMemory', value: { ...knowledge('设定乙'), citation: '章\u200e节一' } })).state.memories[1]!.current;
  await assert.rejects(repo.apply(pet, 3, { type: 'confirmMemory', id: second.id }), code('knowledge_conflict'));
});

test('an inaccessible empty root can recover and only the owning repository retries lock cleanup', posix, async t => {
  let root: string, makeInaccessible = false;
  const fixtureResult = await fixture(t, { syncDirectory: async () => {
    if (makeInaccessible) { await chmod(root, 0o755); throw new Error('temporary directory fault'); }
  } });
  const { repo, open } = fixtureResult;
  root = fixtureResult.root;
  await chmod(root, 0o755);
  await assert.rejects(repo.read(pet), code('character_storage_unavailable'));
  await chmod(root, 0o700);
  assert.equal((await repo.read(pet)).revision, 0);
  makeInaccessible = true;
  assert.equal((await repo.apply(pet, 0, { type: 'saveIdentity', value: identity('已发布') })).durability, 'unconfirmed');
  await chmod(root, 0o700);
  makeInaccessible = false;
  const second = open();
  assert.equal((await second.read(pet)).identity?.name, '已发布');
  await assert.rejects(second.apply(pet, 1, { type: 'saveIdentity', value: identity('不能抢占') }), code('character_busy'));
  assert.equal((await repo.apply(pet, 1, { type: 'saveIdentity', value: identity('恢复后保存') })).state.revision, 2);
  assert.equal((await second.read(pet)).identity?.name, '恢复后保存');
  makeInaccessible = true;
  assert.equal((await repo.apply(pet, 2, { type: 'saveIdentity', value: identity('关闭前最后一次保存') })).durability, 'unconfirmed');
  await assert.rejects(repo.close(), code('character_storage_unavailable'));
  await chmod(root, 0o700);
  makeInaccessible = false;
  await assert.rejects(repo.apply(pet, 3, { type: 'saveIdentity', value: identity('关闭后不能再写') }), code('character_storage_unavailable'));
  await repo.close();
  assert.equal((await second.apply(pet, 3, { type: 'saveIdentity', value: identity('确认写锁已清理') })).state.revision, 4);
});

test('online approvals follow only the current saved version and do not enter history', posix, async t => {
  const { repo, open } = await fixture(t);
  const apply = (expected: number, command: unknown) => repo.apply(pet, expected, command);
  const share = { type: 'setIdentityChatShare', enabled: true };
  assert.equal((await apply(0, { type: 'saveIdentity', value: identity('首版') })).state.identity?.chatShare, undefined);
  assert.equal((await apply(1, share)).state.identity?.revision, 1);
  assert.equal((await open().read(pet)).identity?.chatShare, true);
  assert.equal((await apply(2, { type: 'saveIdentity', value: identity('首版') })).state.identity?.chatShare, true);
  const revised = await apply(2, { type: 'saveIdentity', value: identity('新版本') });
  assert.equal(revised.state.identity?.chatShare, undefined);
  assert.equal(revised.state.identityHistory[0]?.chatShare, undefined);
  assert.equal((await apply(3, { type: 'restoreIdentity', revision: 1 })).state.identity?.chatShare, undefined);
  const mem = (await apply(4, { type: 'addMemory', value: knowledge('合成知识') })).state.memories[0]!.current.id;
  await apply(5, { type: 'confirmMemory', id: mem });
  await apply(6, { type: 'setMemoryChatShare', id: mem, enabled: true });
  const edited = await apply(7, { type: 'editMemory', id: mem, value: knowledge('不同的知识') });
  assert.equal(edited.state.memories[0]?.history[0]?.chatShare, undefined);
  assert.equal(edited.state.memories[0]?.current.chatShare, undefined);
  await apply(8, { type: 'confirmMemory', id: mem });
  await apply(9, { type: 'setMemoryChatShare', id: mem, enabled: true });
  await apply(10, { type: 'withdrawMemory', id: mem });
  const confirmedAgain = await apply(11, { type: 'confirmMemory', id: mem });
  assert.equal(confirmedAgain.state.memories[0]?.current.chatShare, undefined);
  const item = (await apply(12, { type: 'addGoal', value: goal('合成步骤') })).state.goals[0]!;
  await apply(13, { type: 'setGoalChatShare', id: item.id, enabled: true });
  const steps = item.steps.map(step => ({ ...step, isComplete: true }));
  const result = await apply(14, { type: 'editGoal', id: item.id, value: { ...goal('合成步骤'), steps } });
  assert.equal(result.state.goals[0]?.chatShare, undefined);
  assert.equal(result.state.goals[0]?.steps[0]?.id, item.steps[0]?.id);
  await assert.rejects(apply(15, { type: 'saveIdentity', value: { ...identity('内容'), chatShare: true } }), code('invalid_character_data'));
});

test('unconfirmed publication blocks online context reads without hiding local records', posix, async t => {
  let failSync = false;
  const { repo } = await fixture(t, { syncDirectory: async () => { if (failSync) throw Error('synthetic disk error'); } });
  await repo.apply(pet, 0, { type: 'saveIdentity', value: identity('本机角色') });
  await repo.apply(pet, 1, { type: 'setIdentityChatShare', enabled: true });
  assert.equal((await repo.readForOnlineChat(pet)).identity?.chatShare, true);
  failSync = true;
  assert.equal((await repo.apply(pet, 2, { type: 'setIdentityChatShare', enabled: false })).durability, 'unconfirmed');
  assert.equal((await repo.read(pet)).identity?.chatShare, undefined);
  await assert.rejects(repo.readForOnlineChat(pet), code('character_publication_uncertain'));
  assert.equal((await repo.readForOnlineChat(other)).revision, 0);
});

const legacyBatch = {
  identity: identity('旧角色'),
  memories: [{ kind: '事实', text: '本机合成记忆', source: '合成', citation: '', version: '' }],
  goals: [{ ...goal('已完成的旧步骤'), steps: [{ text: '已完成的旧步骤', isComplete: true }] }],
};

test('legacy import publishes a single private batch and can undo it after reopening', posix, async t => {
  const { repo, open } = await fixture(t);
  const operation = { type: 'importLegacy', value: legacyBatch };
  const { state } = await repo.apply(pet, 0, operation);
  assert.equal(state.revision, 1);
  assert.equal(state.legacyImport, true);
  assert.equal(state.identity?.name, '旧角色');
  assert.equal(state.memories[0]?.current.status, 'candidate');
  assert.equal(state.goals[0]?.steps[0]?.isComplete, true);
  assert.ok([state.identity, state.memories[0]?.current, state.goals[0]].every(record => record?.chatShare === undefined));
  assert.equal((await repo.read(other)).revision, 0);
  const reopened = open();
  assert.equal((await reopened.read(pet)).legacyImport, true);
  await assert.rejects(reopened.apply(pet, 0, { type: 'undoLegacyImport' }), code('character_conflict'));
  const { state: undone } = await reopened.apply(pet, 1, { type: 'undoLegacyImport' });
  assert.deepEqual(undone, { schemaVersion: 1, petID: pet, revision: 2, identity: null, identityHistory: [], memories: [], goals: [] });
  await assert.rejects(reopened.apply(pet, 2, { type: 'undoLegacyImport' }), code('character_conflict'));
  assert.equal((await reopened.apply(pet, 2, operation)).state.revision, 3);
});

test('legacy import refuses occupied destinations, forged grants and undo after edits', posix, async t => {
  const { repo } = await fixture(t);
  await assert.rejects(repo.apply(pet, 0, { type: 'importLegacy', value: { ...legacyBatch, identity: { ...legacyBatch.identity, chatShare: true } } }), code('invalid_character_data'));
  await assert.rejects(repo.apply(pet, 0, { type: 'importLegacy', value: { ...legacyBatch, memories: [{ ...legacyBatch.memories[0], text: 'API key 示例' }] } }), code('invalid_character_data'));
  await repo.apply(other, 0, { type: 'saveIdentity', value: identity('保留') });
  await assert.rejects(repo.apply(other, 1, { type: 'importLegacy', value: legacyBatch }), code('character_conflict'));
  assert.equal((await repo.read(other)).identity?.name, '保留');
  await repo.apply(pet, 0, { type: 'importLegacy', value: legacyBatch });
  await repo.apply(pet, 1, { type: 'saveIdentity', value: identity('后来调整') });
  await assert.rejects(repo.apply(pet, 2, { type: 'undoLegacyImport' }), code('character_conflict'));
  assert.equal((await repo.read(pet)).identity?.name, '后来调整');
  assert.equal((await repo.read(pet)).legacyImport, undefined);
});

test('failed legacy publication writes none of the batch and leaves an undoable batch intact', posix, async t => {
  let fail = true;
  const { repo } = await fixture(t, { rename: async (from, to) => {
    if (fail) throw Error('injected before publication');
    await rename(from, to);
  } });
  const operation = { type: 'importLegacy', value: legacyBatch };
  await assert.rejects(repo.apply(pet, 0, operation), code('character_storage_unavailable'));
  assert.equal((await repo.read(pet)).revision, 0);
  fail = false;
  const { state } = await repo.apply(pet, 0, operation);
  fail = true;
  await assert.rejects(repo.apply(pet, 1, { type: 'undoLegacyImport' }), code('character_storage_unavailable'));
  assert.deepEqual(await repo.read(pet), state);
});
