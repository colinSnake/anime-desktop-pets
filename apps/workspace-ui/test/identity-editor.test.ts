import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IdentityPage } from '../src/pages/IdentityPage.tsx';
import { IdentityWorkspace, identityDirty } from '../src/pages/identity-editor.ts';
import { characterPersonaSuggestions, liveRolePackages } from '../../../packages/contracts/src/character-personas.ts';
import type { IdentityBridge, IdentityDraft, IdentitySnapshot, IdentityWriteResult } from '../../../packages/contracts/src/characters.ts';

const fixture = (petID: string, revision: number, name: string): IdentitySnapshot => ({
  schemaVersion: 1, revision, petID, identityHistory: [],
  identity: { ...draft(name), revision, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
});
const draft = (name: string): IdentityDraft => ({ name, role: '', background: '', personality: '', values: '', motivations: '', relationship: '', speakingStyle: '', knowledgeScope: '', boundaries: '' });
const ok = (snapshot: IdentitySnapshot) => ({ ok: true as const, snapshot });
const confirmed = (snapshot: IdentitySnapshot) => ({ ...ok(snapshot), durability: 'confirmed' as const });
const blankIdentity = (petID: string): IdentitySnapshot => ({ schemaVersion: 1, revision: 4, petID, identityHistory: [], identity: null });
const bridge = (overrides: Partial<IdentityBridge>): IdentityBridge => ({
  readIdentity: async () => assert.fail('unexpected read'), saveIdentity: async () => assert.fail('unexpected save'), restoreIdentity: async () => assert.fail('unexpected restore'),
  setIdentityChatShare: async () => assert.fail('unexpected sharing change'), ...overrides,
});

test('each built-in persona fills only the selected instance draft until an explicit local save', async () => {
  const dragon = { id: 'pet-dragon', displayName: '龙妹分身', package: liveRolePackages.longmei };
  const whale = { id: 'pet-whale', displayName: '我的鲸鱼', package: liveRolePackages.dafeiyu };
  const saves: Parameters<IdentityBridge['saveIdentity']>[0][] = [];
  const workspace = new IdentityWorkspace(bridge({ readIdentity: async ({ petID }) => ok(blankIdentity(petID)),
    saveIdentity: async input => {
      saves.push(input);
      const result = fixture(input.petID, 5, input.draft.name);
      return confirmed({ ...result, identity: { ...result.identity!, ...input.draft } });
    },
  }));
  const a = workspace.forPet(dragon.id), b = workspace.forPet(whale.id);
  await a.load(); await b.load();
  const html = (instance: typeof dragon, editor: typeof a, connected = true) => renderToStaticMarkup(createElement(IdentityPage, {
    draft: { value: draft(''), update: () => {} }, connected, instance, editor,
  }));
  assert.match(html(dragon, a), /<button[^>]*>使用龙妹人格建议<\/button>/);
  assert.match(html(whale, b), /<button[^>]*>使用鲸鱼妹人格建议<\/button>/);
  assert.doesNotMatch(html(whale, a), /使用.*人格建议/);
  assert.doesNotMatch(html(dragon, a, false), /使用.*人格建议/);
  assert.doesNotMatch(html({ ...dragon, package: { ...dragon.package, version: '9.9.9' } }, a), /使用.*人格建议/);
  a.applySuggestion(dragon);
  assert.deepEqual(a.getSnapshot().draft, characterPersonaSuggestions.longmei);
  assert.notEqual(a.getSnapshot().draft, characterPersonaSuggestions.longmei);
  assert.equal(a.getSnapshot().snapshot?.identity, null);
  assert.deepEqual(b.getSnapshot().draft, draft(''));
  assert.match(html(dragon, a), /已填入草稿，尚未保存/);
  assert.doesNotMatch(html(dragon, a), /使用龙妹人格建议/);
  a.discardDraft();
  assert.match(html(dragon, a), /<button[^>]*>使用龙妹人格建议<\/button>/);
  b.applySuggestion(whale);
  assert.deepEqual(b.getSnapshot().draft, characterPersonaSuggestions.dafeiyu);
  b.change('name', '我的鲸鱼妹');
  assert.deepEqual(saves, []);
  await b.save();
  assert.deepEqual(saves, [{ petID: whale.id, expectedRevision: 4, draft: { ...characterPersonaSuggestions.dafeiyu, name: '我的鲸鱼妹' } }]);
  assert.equal(b.getSnapshot().snapshot?.identity?.chatShare, undefined);
  assert.equal(b.getSnapshot().notice, 'saved');
  assert.deepEqual(a.getSnapshot().draft, draft(''));
});

test('persona suggestion refuses a stale click, mismatched instance or package, and any hand-written field', async () => {
  const instance = { id: 'pet-dragon', package: liveRolePackages.longmei };
  const editor = new IdentityWorkspace(bridge({ readIdentity: async () => ok(blankIdentity(instance.id)) })).forPet(instance.id);
  const applyAndExpectNoChange = (target = instance) => {
    const before = editor.getSnapshot();
    editor.applySuggestion(target);
    assert.equal(editor.getSnapshot(), before);
  };
  applyAndExpectNoChange();
  const loading = editor.load();
  applyAndExpectNoChange();
  await loading;
  applyAndExpectNoChange({ ...instance, id: 'pet-whale' });
  applyAndExpectNoChange({ ...instance, package: { ...instance.package, id: 'other' } });
  applyAndExpectNoChange({ ...instance, package: { ...instance.package, version: '9.9.9' } });
  editor.change('boundaries', ' ');
  applyAndExpectNoChange();
  editor.change('boundaries', '我的边界');
  applyAndExpectNoChange();
  editor.retire();
  applyAndExpectNoChange();
});

test('persona suggestion never replaces an existing identity or treats a failed refresh as blank', async () => {
  const instance = { id: 'pet-dragon', package: liveRolePackages.longmei };
  let response = ok(blankIdentity(instance.id)) as Awaited<ReturnType<IdentityBridge['readIdentity']>>;
  const editor = new IdentityWorkspace(bridge({ readIdentity: async () => response })).forPet(instance.id);
  const trySuggestion = () => {
    const before = editor.getSnapshot();
    editor.applySuggestion(instance);
    assert.equal(editor.getSnapshot(), before);
  };
  await editor.load();
  response = { ok: false, error: 'unavailable' };
  await editor.load();
  assert.equal(editor.getSnapshot().snapshot?.identity, null);
  assert.equal(editor.getSnapshot().review, 'read-required');
  trySuggestion();
  const saved = fixture(instance.id, 5, '自己的设定');
  saved.identityHistory = [fixture(instance.id, 4, '更早的设定').identity!];
  response = ok(saved);
  await editor.load();
  trySuggestion();
  editor.inspectHistory(4);
  assert.equal(editor.getSnapshot().inspecting, 4);
  trySuggestion();
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
