import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { ChatHistory } from '../src/chat-history.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pet-chat-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'chats.sqlite');
  await writeFile(path, '', { mode: 0o600 });
  return { root, path };
}
const turn = (requestID = randomUUID()) => ({ requestID, user: '合成问题', assistant: '合成回答', completedAt: 1_700_000_000_000 });
const start = () => ({ id: randomUUID(), mode: 'new' as const });
const resume = ({ id }: { id: string }) => ({ id, mode: 'resume' as const });
const use = { skip: process.platform === 'win32' };

test('commits to stable sessions, deduplicates, reopens, and walks only the requested pet', use, async t => {
  const { root, path } = await fixture(t);
  const history = new ChatHistory(root);
  const first = turn(), session = start();
  await history.append('pet-a', session, first, true);
  await history.append('pet-a', resume(session), first, true);
  await assert.rejects(history.append('pet-a', resume(session), { ...first, assistant: '不同回答' }, true));
  await assert.rejects(history.append('pet-b', resume(session), turn(), true));
  await assert.rejects(history.append('pet-b', session, turn(), true));
  await history.append('pet-b', start(), turn(), true);
  for (let i = 0; i < 7; i++) await history.append('pet-a', start(), turn(), true);
  const latest = { ...turn(), assistant: '新回复' };
  await history.append('pet-a', resume(session), latest, false);
  await history.close();
  const reopened = new ChatHistory(root);
  t.after(() => reopened.close());
  const page = await reopened.list('pet-a');
  assert.equal(page.rows.length, 5);
  assert.deepEqual(page.rows[0], { id: session.id, number: 1, completedAt: latest.completedAt });
  assert.equal((await reopened.list('pet-a', page.nextBefore!)).rows.length, 3);
  assert.deepEqual(await reopened.detail('pet-a', session.id), { session: page.rows[0], turns: [first, latest], hasEarlier: false });
  assert.deepEqual(await reopened.replay('pet-a', resume(session)), [{ user: first.user, assistant: first.assistant }]);
  assert.equal(await reopened.detail('pet-b', session.id), undefined);
  await assert.rejects(reopened.list('pet-b', page.nextBefore!));
  await reopened.clear('pet-a');
  assert.deepEqual(await reopened.list('pet-a'), { rows: [], nextBefore: null });
  assert.equal(await reopened.replay('pet-a', resume(session)), undefined);
  assert.equal((await reopened.list('pet-b')).rows.length, 1);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
});

test('replaces the recognized old question-answer schema without importing rows', use, async t => {
  const { root, path } = await fixture(t);
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE turns (
  seq INTEGER PRIMARY KEY,
  pet_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  user_text TEXT NOT NULL CHECK(length(CAST(user_text AS BLOB)) BETWEEN 1 AND 12288),
  assistant_text TEXT NOT NULL CHECK(length(CAST(assistant_text AS BLOB)) BETWEEN 1 AND 24576),
  completed_at INTEGER NOT NULL,
  UNIQUE(pet_id, request_id)
) STRICT;
CREATE INDEX turns_pet_seq ON turns(pet_id, seq DESC);
PRAGMA application_id=1094996052;
PRAGMA user_version=1;
INSERT INTO turns VALUES (1, 'pet-a', 'legacy', '旧问答', '旧回复', 1700000000000);`);
  db.close();
  const history = new ChatHistory(root);
  t.after(() => history.close());
  assert.deepEqual(await history.list('pet-a'), { rows: [], nextBefore: null });
  await history.append('pet-a', start(), turn(), true);
  assert.equal((await history.list('pet-a')).rows.length, 1);
});

test('refuses unsafe files and never recreates a missing database', use, async t => {
  const { root, path } = await fixture(t);
  await chmod(path, 0o644);
  const history = new ChatHistory(root);
  t.after(() => history.close());
  await assert.rejects(history.list('pet-a'));
  await rm(path);
  await assert.rejects(history.list('pet-a'));
  await symlink(join(root, 'absent'), path);
  await assert.rejects(history.list('pet-a'));
});

test('never writes cancelled, local command, or credential-like content and bounds reads', use, async t => {
  const { root } = await fixture(t);
  const history = new ChatHistory(root), session = start();
  t.after(() => history.close());
  await assert.rejects(history.append('pet-a', session, turn(), true, AbortSignal.abort()));
  await assert.rejects(history.append('pet-a', session, { ...turn(), user: '你是谁' }, true));
  await assert.rejects(history.append('pet-a', session, { ...turn(), user: '记住：合成资料' }, true));
  await assert.rejects(history.append('pet-a', session, { ...turn(), assistant: `Bearer ${'x'.repeat(45)}` }, true));
  assert.equal((await history.list('pet-a')).rows.length, 0);
  for (let i = 0; i < 8; i++) await history.append('pet-a', i === 0 ? session : resume(session), { ...turn(), user: `合成问题 ${i}` }, true);
  const detail = await history.detail('pet-a', session.id);
  assert.equal(detail?.hasEarlier, true);
  assert.deepEqual(detail?.turns.map(row => row.user), [2, 3, 4, 5, 6, 7].map(i => `合成问题 ${i}`));
  assert.equal((await history.replay('pet-a', resume(session)))?.length, 5);
});

test('history pages keep their original boundary when the last visible session receives a reply', use, async t => {
  const { root } = await fixture(t);
  const history = new ChatHistory(root);
  t.after(() => history.close());
  for (let i = 1; i <= 6; i++) await history.append('pet-a', start(), turn(), true);
  const page = await history.list('pet-a');
  assert.deepEqual(page.rows.map(row => row.number), [6, 5, 4, 3, 2]);
  const boundary = page.nextBefore!;
  await history.append('pet-a', resume(page.rows.at(-1)!), turn(), true);
  assert.deepEqual((await history.list('pet-a', boundary)).rows.map(row => row.number), [1]);
  await assert.rejects(history.list('pet-b', boundary));
  await history.clear('pet-a');
  await assert.rejects(history.list('pet-a', boundary));
});

test('detail walks bounded older pages without overlap, even after an append', use, async t => {
  const { root } = await fixture(t);
  const history = new ChatHistory(root);
  t.after(() => history.close());
  const session = start(), other = start(), foreign = start();
  const rows = Array.from({ length: 14 }, (_, i) => ({ ...turn(), user: `合成第 ${i + 1} 问` }));
  for (const row of rows) await history.append('pet-a', session, row, true);
  const otherTurn = turn(), foreignTurn = turn();
  await history.append('pet-a', other, otherTurn, true);
  await history.append('pet-b', foreign, foreignTurn, true);
  const current = await history.detail('pet-a', session.id);
  assert.deepEqual(current?.turns, rows.slice(-6));
  assert.equal(current?.before, undefined);
  const before = current!.turns[0]!.requestID;
  await history.append('pet-a', resume(session), { ...turn(), completedAt: rows[0]!.completedAt + 1 }, true);
  const older = await history.detail('pet-a', session.id, before);
  assert.deepEqual(older?.turns, rows.slice(2, 8));
  assert.equal(older?.before, before);
  assert.equal(older?.hasEarlier, true);
  const oldest = await history.detail('pet-a', session.id, older!.turns[0]!.requestID);
  assert.deepEqual(oldest?.turns, rows.slice(0, 2));
  assert.equal(oldest?.hasEarlier, false);
  for (const invalid of [rows[0]!.requestID, otherTurn.requestID, foreignTurn.requestID, randomUUID()]) {
    assert.equal(await history.detail('pet-a', session.id, invalid), undefined);
  }
  assert.equal(await history.detail('pet-b', session.id, before), undefined);
  assert.equal((await history.replay('pet-a', resume(session)))?.length, 5);
  await history.clear('pet-a');
  assert.equal(await history.detail('pet-a', session.id, before), undefined);
});
