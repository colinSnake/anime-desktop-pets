import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IdentityPage } from '../src/pages/IdentityPage.tsx';
import { IdentityWorkspace, identityDirty } from '../src/pages/identity-editor.ts';
import type { IdentityBridge, IdentityDraft, IdentitySnapshot, IdentityWriteResult } from '../../../packages/contracts/src/characters.ts';

const fixture = (petID: string, revision: number, name: string): IdentitySnapshot => ({
  schemaVersion: 1, revision, petID, identityHistory: [],
  identity: { ...draft(name), revision, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
});
const draft = (name: string): IdentityDraft => ({ name, role: '', background: '', personality: '', values: '', motivations: '', relationship: '', speakingStyle: '', knowledgeScope: '', boundaries: '' });
const ok = (snapshot: IdentitySnapshot) => ({ ok: true as const, snapshot });
const confirmed = (snapshot: IdentitySnapshot) => ({ ...ok(snapshot), durability: 'confirmed' as const });
const bridge = (overrides: Partial<IdentityBridge>): IdentityBridge => ({
  readIdentity: async () => assert.fail('unexpected read'), saveIdentity: async () => assert.fail('unexpected save'), restoreIdentity: async () => assert.fail('unexpected restore'),
  setIdentityChatShare: async () => assert.fail('unexpected sharing change'), ...overrides,
});

test('a conflict preserves the draft and requires reviewing the latest snapshot before another save', async () => {
  let source = fixture('pet-one', 1, '已保存'), calls = 0;
  const editor = new IdentityWorkspace(bridge({ readIdentity: async () => ok(source), saveIdentity: async input => {
    calls++;
    if (calls === 1) {
      assert.equal(input.expectedRevision, 1);
      source = fixture('pet-one', 2, '外部更新');
      return { ok: false, error: 'conflict' };
    }
    assert.equal(input.expectedRevision, 2);
    assert.equal(input.draft.name, '我的草稿');
    return confirmed(fixture('pet-one', 3, '我的草稿'));
  } })).forPet('pet-one');
  await editor.load();
  editor.change('name', '我的草稿');
  assert.equal(identityDirty(editor.getSnapshot()), true);
  await editor.save();
  assert.equal(editor.getSnapshot().draft?.name, '我的草稿');
  assert.equal(editor.getSnapshot().review, 'read-required');
  await editor.save();
  assert.equal(calls, 1);
  await editor.load();
  assert.equal(editor.getSnapshot().snapshot?.identity?.name, '外部更新');
  assert.equal(editor.getSnapshot().inspecting, 'saved');
  await editor.save();
  assert.equal(calls, 1);
  editor.returnToDraft();
  await editor.save();
  assert.equal(editor.getSnapshot().notice, 'saved');
  assert.equal(identityDirty(editor.getSnapshot()), false);
});

test('late replies stay with their original instance and deleted instance state is retired', async () => {
  let settle!: (result: IdentityWriteResult) => void;
  const workspace = new IdentityWorkspace(bridge({ readIdentity: async ({ petID }) => ok(fixture(petID, 1, petID)),
    saveIdentity: () => new Promise(resolve => { settle = resolve; }),
  }));
  const a = workspace.forPet('pet-a'), b = workspace.forPet('pet-b');
  await a.load(); a.change('name', '甲草稿');
  const pending = a.save(); await b.load(); b.change('name', '乙草稿');
  assert.equal(workspace.forPet('pet-a'), a);
  workspace.keepRegistered(['pet-b']);
  settle(confirmed(fixture('pet-a', 2, '甲草稿'))); await pending;
  assert.equal(b.getSnapshot().draft?.name, '乙草稿');
  assert.equal(b.getSnapshot().snapshot?.revision, 1);
  assert.equal(a.getSnapshot().snapshot, undefined);
});

test('restore requires inspecting history and will not replace an unsaved draft or repeat an uncertain write', async () => {
  const now = fixture('pet-one', 2, '第二版');
  now.identityHistory = [fixture('pet-one', 1, '第一版').identity!];
  let restoreCount = 0, current = now;
  const editor = new IdentityWorkspace(bridge({ readIdentity: async () => ok(current), restoreIdentity: async input => {
    restoreCount++;
    assert.deepEqual(input, { petID: 'pet-one', expectedRevision: 2, historicalRevision: 1 });
    current = { ...fixture('pet-one', 3, '第一版'), identityHistory: [...now.identityHistory, now.identity!] };
    return { ...confirmed(current), durability: 'unconfirmed' };
  } })).forPet('pet-one');
  await editor.load();
  await editor.restore();
  editor.change('name', '未保存'); editor.inspectHistory(1); await editor.restore();
  assert.equal(restoreCount, 0);
  editor.returnToDraft(); editor.discardDraft(); editor.inspectHistory(1); await editor.restore();
  assert.equal(restoreCount, 1);
  assert.equal(editor.getSnapshot().review, 'read-required');
  assert.equal(editor.getSnapshot().notice, undefined);
  await editor.restore(); assert.equal(restoreCount, 1);
  await editor.load();
  assert.equal(editor.getSnapshot().snapshot?.revision, 3);
  assert.equal(editor.getSnapshot().draft?.name, '第一版');
  assert.equal(editor.getSnapshot().notice, 'reloaded');
});


test('a failed refresh preserves the draft and blocks stale saves and history until a successful read', async () => {
  const current = fixture('pet-one', 2, '第二版');
  current.identityHistory = [fixture('pet-one', 1, '第一版').identity!];
  let fail = false;
  const editor = new IdentityWorkspace(bridge({ readIdentity: async () => fail ? { ok: false, error: 'unavailable' } : ok(current) })).forPet('pet-one');
  await editor.load();
  editor.change('name', '未保存');
  fail = true;
  await editor.load();
  assert.equal(editor.getSnapshot().review, 'read-required');
  editor.inspectHistory(1);
  editor.change('name', '不能覆盖草稿');
  await editor.save();
  assert.equal(editor.getSnapshot().inspecting, undefined);
  assert.equal(editor.getSnapshot().draft?.name, '未保存');
  fail = false;
  await editor.load();
  assert.equal(editor.getSnapshot().inspecting, 'saved');
  editor.returnToDraft();
  assert.equal(editor.getSnapshot().draft?.name, '未保存');
});

test('connected identity renders editable fields and protects the draft while previewing history', async () => {
  const current = fixture('pet-one', 2, '第二版');
  current.identityHistory = [fixture('pet-one', 1, '第一版').identity!];
  const editor = new IdentityWorkspace(bridge({ readIdentity: async () => ok(current) })).forPet('pet-one');
  const html = () => renderToStaticMarkup(createElement(IdentityPage, { draft: { value: draft(''), update: () => {} },
    connected: true, instance: { id: 'pet-one' }, editor }));
  await editor.load();
  editor.change('name', '未保存');
  assert.match(html(), /<button(?:(?!disabled)[^>])*>保存身份<\/button>/);
  assert.match(html(), /<input(?:(?!readonly)[^>])*value="未保存"/i);
  editor.inspectHistory(1);
  assert.match(html(), /<input[^>]*readOnly=""[^>]*value="第一版"/i);
  assert.match(html(), /<button[^>]*disabled=""[^>]*>恢复为新版本<\/button>/);
  editor.returnToDraft(); editor.discardDraft(); editor.inspectHistory(1);
  assert.match(html(), /<button(?:(?!disabled)[^>])*>恢复为新版本<\/button>/);
});

test('identity approval binds the saved snapshot and keeps an unknown result out of the page', async () => {
  const petID = 'pet-one', source = fixture(petID, 1, '保存资料');
  let sent = 0;
  const editor = new IdentityWorkspace(bridge({ readIdentity: async () => ok(source), setIdentityChatShare: async input => {
    sent++;
    assert.deepEqual(input, { petID, expectedRevision: 1, enabled: true });
    return { ok: true, durability: 'unconfirmed', snapshot: { ...source, revision: 2, identity: { ...source.identity!, chatShare: true } } };
  } })).forPet(petID);
  await editor.load();
  editor.change('name', '未保存的资料');
  await editor.setChatShare(true);
  assert.equal(sent, 0);
  editor.discardDraft();
  await editor.setChatShare(true);
  assert.equal(sent, 1);
  assert.equal(editor.getSnapshot().snapshot?.identity?.chatShare, undefined);
  assert.equal(editor.getSnapshot().review, 'read-required');
});
