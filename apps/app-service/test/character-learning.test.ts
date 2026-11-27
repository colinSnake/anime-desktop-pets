import { characterLearningIPC } from '../../../packages/contracts/src/character-learning-ipc.ts';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { longmei } from '../../../packages/contracts/src/built-in-pets.ts';
import type { ChatRoute } from '../../../packages/contracts/src/online-chat.ts';
import type { ModelInput, ModelReply } from '../src/models/types.ts';
import type { ModelManagement } from '../src/models/management.ts';
import { CharacterRepository } from '../src/characters/repository.ts';
import { ChatHistory } from '../src/chat-history.ts';
import { PetWorkspace } from '../src/pet-workspace.ts';
import { LiveRoleBindingStore } from '../src/live/role-bindings.ts';
import { LiveShareStore } from '../src/live/sharing.ts';

const route: ChatRoute = { connectionID: 'provider', modelEntryID: 'model', fingerprint: 'a'.repeat(64) };
const valid = JSON.stringify({ kind: '偏好', style: 'concise' });
async function modules() {
  const learning = await import('../src/characters/learning.ts').catch(() => undefined);
  assert.ok(learning?.CharacterLearning, 'Task7 must implement the trusted CharacterLearning service');
  return learning;
}
async function fixture(t: TestContext, io?: ConstructorParameters<typeof CharacterRepository>[1], chat = false) {
  const { CharacterLearning } = await modules();
  const root = await mkdtemp(join(await realpath(tmpdir()), 'character-learning-'));
  const workspace = new PetWorkspace({ root: join(root, 'workspace'), catalog: [{ ...longmei, name: '龙妹' }] });
  const characters = new CharacterRepository(join(root, 'characters'), io);
  const bindings = new LiveRoleBindingStore(join(root, 'live'));
  const shares = new LiveShareStore(join(root, 'live'));
  const added = await workspace.mutate('add', { expectedRevision: 0, package: longmei });
  assert.ok(added.ok);
  const petID = added.workspace.instances[0]!.id;
  await bindings.write(0, { longmei: petID, dafeiyu: null });
  let now = 10_000, output = valid, calls = 0, fail = false, current = true;
  let beforeReply: (() => Promise<void>) | undefined;
  const seen: ModelInput[] = [];
  const models = {
    listChatModels: async () => [{ route, isDefault: true }],
    assertChatRoute: async () => undefined,
    withChatPublication: async (_route: ChatRoute, _effort: unknown, publish: () => Promise<unknown>) => publish(),
    completeChat: async (_route: ChatRoute, prepare: (dispatch: (input: ModelInput) => void, signal: AbortSignal) => Promise<void>, signal: AbortSignal): Promise<ModelReply> => {
      calls++;
      await prepare(input => { seen.push(input); }, signal);
      await beforeReply?.();
      if (fail) throw new Error('synthetic_provider_failure');
      return { message: { role: 'assistant', text: output }, stop: 'end', usage: {} };
    },
  } as unknown as ModelManagement;
  if (chat) await writeFile(join(root, 'chats.sqlite'), '', { mode: 0o600 });
  const history = chat ? new ChatHistory(root) : undefined;
  const learning = new CharacterLearning({ workspace, characters, bindings, shares, models, now: () => now, chatHistory: history });
  t.after(async () => { learning.close(); await Promise.all([workspace.close(), characters.close(), bindings.close(), shares.close(), history?.close()]); await rm(root, { recursive: true, force: true }); });
  const turn = () => ({ petID, role: 'longmei' as const, bindingRevision: 1, user: '这次请讲得短一些，合成输入甲', assistant: '好的，我简短说明，合成回复乙', isCurrent: () => current });
  const issue = () => learning.issueLiveTurn(turn());
  const preview = async () => {
    const ticket = await issue();
    const result = await learning.preview({ petID, ticket: ticket.ticket });
    assert.ok(result.ok);
    return { petID, ticket: ticket.ticket, confirmation: result.preview.confirmation, expectedRevision: result.preview.revision, confirmed: true as const };
  };
  return { root, workspace, characters, bindings, shares, models, history, learning, petID, seen, turn, issue, preview,
    calls: () => calls, output: (text: string) => { output = text; }, fail: () => { fail = true; }, expire: () => { now += 60_001; },
    stale: () => { current = false; }, beforeReply: (fn: () => Promise<void>) => { beforeReply = fn; } };
}

test('trusted service exists; no source round is persisted before explicit preview and confirmation', async t => {
  const f = await fixture(t);
  const ticket = await f.issue();
  assert.match(ticket.ticket, /^[a-f0-9]{48}$/);
  assert.equal(f.calls(), 0);
  assert.equal((await f.characters.read(f.petID)).revision, 0);
  const result = await f.learning.generate({ petID: f.petID, ticket: ticket.ticket, confirmation: 'b'.repeat(48), expectedRevision: 0, confirmed: true });
  assert.equal(result.ok, false);
  assert.equal(f.calls(), 0);
});

test('preview reads the owned single turn and generation writes exactly one unshared preference candidate', async t => {
  const f = await fixture(t);
  const request = await f.preview();
  assert.equal(f.calls(), 0);
  const result = await f.learning.generate(request);
  assert.ok(result.ok);
  const state = await f.characters.read(f.petID);
  assert.equal(state.memories.length, 1);
  const memory = state.memories[0]!.current;
  assert.equal(memory.id, result.candidateID);
  assert.equal(memory.text, '回复保持简短，优先给出重点。');
  assert.equal(memory.kind, '偏好'); assert.equal(memory.status, 'candidate');
  assert.equal(memory.chatShare, undefined);
  assert.deepEqual((await f.shares.read()).grants, []);
  assert.equal(state.identity, null); assert.deepEqual(state.goals, []);
  const persisted = await readFile(join(f.root, 'characters', `${f.petID}.json`), 'utf8');
  assert.ok(!persisted.includes('合成输入甲') && !persisted.includes('合成回复乙'));
  assert.equal(f.seen.length, 1);
  const input = f.seen[0]!;
  assert.equal(input.messages.length, 1); assert.equal(input.messages[0]!.role, 'user');
  assert.deepEqual(Object.keys(input).sort(), ['messages', 'system']);
  assert.deepEqual(Object.keys(input.messages[0]!).sort(), ['role', 'text']);
  assert.deepEqual(JSON.parse(input.messages[0]!.text), { user: f.turn().user, assistant: f.turn().assistant });
  assert.equal((await f.learning.generate(request)).ok, false);
  assert.equal(f.calls(), 1);
  const confirmed = await f.characters.apply(f.petID, state.revision, { type: 'confirmMemory', id: memory.id });
  assert.equal(confirmed.state.memories[0]!.current.status, 'confirmed');
  assert.equal(confirmed.state.memories[0]!.current.chatShare, undefined);
  const deleted = await f.characters.apply(f.petID, confirmed.state.revision, { type: 'deleteMemory', id: memory.id });
  assert.deepEqual(deleted.state.memories, []);
});

for (const [label, patch] of [
  ['attachments', { attachments: [] }], ['history', { history: [] }], ['tools', { tools: [] }],
  ['failed publication', { published: false }], ['credentials', { user: 'api_key=synthetic-secret' }],
  ['oversize input', { user: '字'.repeat(1001) }], ['wrong role', { role: 'dafeiyu' }],
] as const) test(`ticket issuance rejects ${label}`, async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.learning.issueLiveTurn({ ...f.turn(), ...patch } as never));
  assert.equal(f.calls(), 0); assert.equal((await f.characters.read(f.petID)).revision, 0);
});

for (const output of [
  'not json', '[]', '[{"kind":"偏好","text":"简短"}]',
  '{"kind":"事实","text":"主人住在北京"}', '{"kind":"知识","text":"知识"}', '{"kind":"目标","text":"目标"}',
  '{"kind":"偏好","text":"简短","chatShare":true}', '{"kind":"偏好","text":"api_key=secret"}',
  '{"kind":"偏好","text":""}', JSON.stringify({ kind: '偏好', text: '字'.repeat(301) }),
  '{"kind":"事实","kind":"偏好","style":"concise"}', '{"kind":"偏好","style":"__proto__"}', '{"kind":"偏好","style":"concise","text":"额外文本"}',
]) test(`invalid candidate ${output.slice(0, 45)} never writes`, async t => {
  const f = await fixture(t); f.output(output);
  assert.equal((await f.learning.generate(await f.preview())).ok, false);
  assert.equal((await f.characters.read(f.petID)).revision, 0);
  assert.equal(f.calls(), 1);
});

test('cross-instance preview/generate/cancel cannot use or destroy another instance ticket', async t => {
  const f = await fixture(t), request = await f.preview();
  assert.equal((await f.learning.preview({ petID: 'other-pet', ticket: request.ticket })).ok, false);
  assert.equal((await f.learning.generate({ ...request, petID: 'other-pet' })).ok, false);
  assert.equal(f.learning.cancel({ petID: 'other-pet', ticket: request.ticket }).ok, false);
  assert.ok((await f.learning.generate(request)).ok);
});

for (const boundary of ['expire', 'cancel', 'role-cancel', 'stale', 'unbind', 'revision', 'provider-failure', 'aborted'] as const)
  test(`${boundary} closes generation without a memory write`, async t => {
    const f = await fixture(t), request = await f.preview(), abort = new AbortController();
    if (boundary === 'expire') f.expire();
    if (boundary === 'cancel') f.learning.cancel({ petID: request.petID, ticket: request.ticket });
    if (boundary === 'role-cancel') f.learning.cancelLive('longmei');
    if (boundary === 'stale') f.stale();
    if (boundary === 'unbind') await f.bindings.write(1, { longmei: null, dafeiyu: null });
    if (boundary === 'revision') request.expectedRevision++;
    if (boundary === 'provider-failure') f.fail();
    if (boundary === 'aborted') abort.abort();
    assert.equal((await f.learning.generate(request, abort.signal)).ok, false);
    assert.equal((await f.characters.read(f.petID)).memories.length, 0);
    assert.equal((await f.learning.generate(request)).ok, false);
  });

test('double-click consumes before awaiting provider; late cancelled response never creates a candidate', async t => {
  const f = await fixture(t), request = await f.preview();
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.beforeReply(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
  const first = f.learning.generate(request); await started;
  assert.equal((await f.learning.generate(request)).ok, false);
  f.learning.cancelLive('dafeiyu'); // unrelated cancellation must not affect this role
  f.learning.cancelLive('longmei'); release();
  assert.equal((await first).ok, false);
  assert.equal((await f.characters.read(f.petID)).revision, 0); assert.equal(f.calls(), 1);
});

test('unbind/rebind during model response permanently invalidates the ticket', async t => {
  const f = await fixture(t), request = await f.preview();
  f.beforeReply(async () => { await f.bindings.write(1, { longmei: null, dafeiyu: null }); await f.bindings.write(2, { longmei: f.petID, dafeiyu: null }); });
  assert.equal((await f.learning.generate(request)).ok, false);
  assert.equal((await f.characters.read(f.petID)).revision, 0);
});

test('uncertain publication is reported once and cannot be retried', async t => {
  const f = await fixture(t, { io: { syncDirectory: async () => { throw new Error('synthetic_sync_failure'); } } });
  const request = await f.preview();
  const result = await f.learning.generate(request);
  assert.deepEqual(result, { ok: false, error: 'write-outcome-unknown' });
  assert.equal((await f.learning.generate(request)).ok, false);
  assert.equal((await f.characters.read(f.petID)).memories.length, 1);
  await assert.rejects(() => f.characters.readForOnlineChat(f.petID));
});

test('duplicate normalized preference and rate limits never add extra records', async t => {
  const f = await fixture(t);
  assert.ok((await f.learning.generate(await f.preview())).ok);
  assert.deepEqual(await f.learning.generate(await f.preview()), { ok: false, error: 'duplicate' });
  assert.equal((await f.characters.read(f.petID)).memories.length, 1);
  for (let i = 0; i < 4; i++) { f.fail(); await f.learning.generate(await f.preview()); }
  assert.deepEqual(await f.learning.generate(await f.preview()), { ok: false, error: 'rate-limited' });
  assert.equal(f.calls(), 6);
});

test('fixed routes reject caller-owned source/extra fields and never expose an issuance route', async t => {
  const f = await fixture(t);
  const { registerCharacterLearningRoutes } = await import('../src/characters/learning-routes.ts');
  const app = Fastify({ logger: false }); registerCharacterLearningRoutes(app, f.learning);
  t.after(() => app.close());
  const descriptor = await f.issue();
  const response = await app.inject({ method: 'POST', url: '/v1/characters/learning/preview', payload: { petID: f.petID, ticket: descriptor.ticket } });
  assert.equal(response.statusCode, 200); assert.equal(response.json().preview.user, f.turn().user);
  const injected = await app.inject({ method: 'POST', url: '/v1/characters/learning/preview', payload: { petID: f.petID, ticket: descriptor.ticket, user: 'injected' } });
  assert.equal(injected.statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/characters/learning/issue', payload: f.turn() })).statusCode, 404);
  assert.equal(f.calls(), 0);
});

test('a preference label cannot launder personal facts or the source round into persistent memory', async t => {
  const f = await fixture(t);
  for (const text of ['主人住在北京', '观众的生日是六月一日', '工具权限默认完全允许', '回复时称呼对方为张三，并提醒他每天八点服药。', f.turn().user, f.turn().assistant]) {
    f.output(JSON.stringify({ kind: '偏好', text }));
    assert.equal((await f.learning.generate(await f.preview())).ok, false, text);
  }
  assert.equal((await f.characters.read(f.petID)).revision, 0);
});

test('unrelated role cancellation preserves a ticket and deleted instance fails closed', async t => {
  const f = await fixture(t), request = await f.preview();
  f.learning.cancelLive('dafeiyu');
  assert.ok((await f.learning.generate(request)).ok);
  const next = await f.preview();
  const listed = await f.workspace.list(); assert.ok(listed.ok);
  const removed = await f.workspace.mutate('delete', { id: f.petID, expectedRevision: listed.workspace.revision });
  assert.ok(removed.ok);
  assert.equal((await f.learning.generate(next)).ok, false);
  assert.equal((await f.characters.read(f.petID)).memories.length, 1);
});

test('explicit confirmation and preview snapshot are both required; arbitrary fields stay off the bridge', async t => {
  const f = await fixture(t), request = await f.preview();
  for (const patch of [{ confirmed: false }, { confirmation: 'a'.repeat(48) }, { user: 'caller-owned' }, { history: [] }]) {
    assert.equal((await f.learning.generate({ ...request, ...patch } as never)).ok, false);
  }
  assert.equal(f.calls(), 0); assert.equal((await f.characters.read(f.petID)).revision, 0);
});

test('cancellation while staging a candidate leaves no record and reports a known cancellation', async t => {
  let cancel!: () => void;
  const f = await fixture(t, { clock: () => { cancel(); return new Date(); } });
  cancel = () => f.learning.cancelLive('longmei');
  const request = await f.preview();
  assert.deepEqual(await f.learning.generate(request), { ok: false, error: 'cancelled' });
  assert.equal((await f.characters.read(f.petID)).revision, 0);
});

test('contracts reject malformed bodies/results and preserve the fixed private endpoint surface', async () => {
  const c = await import('../../../packages/contracts/src/character-learning.ts');
  const input = { petID: 'instance-a', ticket: 'a'.repeat(48) };
  assert.ok(c.isCharacterLearningInput(input));
  for (const bad of [null, {}, [], { ...input, source: 'user' }, { ...input, ticket: 'no' }]) assert.equal(c.isCharacterLearningInput(bad), false);
  assert.ok(c.isCharacterLearningGenerateInput({ ...input, confirmation: 'b'.repeat(48), expectedRevision: 0, confirmed: true }));
  assert.equal(c.isCharacterLearningGenerateInput({ ...input, confirmation: 'b'.repeat(48), expectedRevision: -1, confirmed: true }), false);
  assert.deepEqual(characterLearningIPC, { selectChatTurn: 'pet:character-learning-select-chat-turn', preview: 'pet:character-learning-preview', generate: 'pet:character-learning-generate', cancel: 'pet:character-learning-cancel' });
  assert.ok(c.isCharacterLearningCancelResult({ ok: true }));
  assert.equal(c.isCharacterLearningCancelResult({ ok: true, text: 'private' }), false);
  assert.equal(c.isCharacterLearningGenerateResult({ ok: true, petID: 'instance-a', candidateID: 'abc', revision: 1, durability: 'unconfirmed' }), false);
});

test('a rejected replacement does not release another still-draining generation admission', async t => {
  const f = await fixture(t), firstRequest = await f.preview();
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.beforeReply(async () => { if (f.calls() === 1) { entered(); await new Promise<void>(resolve => { release = resolve; }); } });
  const first = f.learning.generate(firstRequest); await started;
  const second = await f.learning.generate(await f.preview());
  const third = await f.learning.generate(await f.preview());
  release(); await first;
  assert.deepEqual(second, { ok: false, error: 'busy' });
  assert.deepEqual(third, { ok: false, error: 'busy' });
  assert.equal(f.calls(), 1); assert.equal((await f.characters.read(f.petID)).revision, 0);
});

const sessionID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const turnID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const otherTurn = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const plainTurn = { user: '回答能更轻松一些吗？', assistant: '好，我会说得更轻松。' };

test('chat selection only previews the selected persisted ordinary turn and cannot read another instance or a material turn', async t => {
  const f = await fixture(t, undefined, true), history = f.history!;
  assert.equal(typeof f.learning.selectChatTurn, 'function', 'trusted chat selection is not implemented');
  await history.append(f.petID, { id: sessionID, mode: 'new' }, { requestID: turnID, ...plainTurn, completedAt: 1 }, true);
  await history.append(f.petID, { id: sessionID, mode: 'resume' }, { requestID: otherTurn, user: '不得载入本轮素材', assistant: '素材回复', completedAt: 2 }, false);
  const selection = { petID: f.petID, sessionID, turnID };
  assert.equal((await f.learning.selectChatTurn({ ...selection, petID: 'other-pet' })).ok, false);
  assert.equal((await f.learning.selectChatTurn({ ...selection, turnID: otherTurn })).ok, false);
  assert.equal((await f.learning.selectChatTurn({ ...selection, sessionID: otherTurn })).ok, false);
  const selected = await f.learning.selectChatTurn(selection);
  assert.ok(selected.ok); assert.equal(selected.preview.source, 'chat');
  assert.equal(selected.preview.user, plainTurn.user); assert.equal(selected.preview.assistant, plainTurn.assistant);
  assert.equal(f.calls(), 0);
  const { ticket, confirmation, revision } = selected.preview;
  const result = await f.learning.generate({ petID: f.petID, ticket, confirmation, expectedRevision: revision, confirmed: true });
  assert.ok(result.ok);
  assert.deepEqual(JSON.parse(f.seen[0]!.messages[0]!.text), plainTurn);
  assert.equal((await f.characters.read(f.petID)).memories[0]!.current.source, '用户主动选择的单条聊天互动');
});

test('clearing the selected chat history after preview makes its ticket unusable before dispatch', async t => {
  const f = await fixture(t, undefined, true), history = f.history!;
  await history.append(f.petID, { id: sessionID, mode: 'new' }, { requestID: turnID, ...plainTurn, completedAt: 1 }, true);
  const selection = await f.learning.selectChatTurn({ petID: f.petID, sessionID, turnID }); assert.ok(selection.ok);
  await history.clear(f.petID);
  const { ticket, confirmation, revision } = selection.preview;
  assert.equal((await f.learning.generate({ petID: f.petID, ticket, confirmation, expectedRevision: revision, confirmed: true })).ok, false);
  assert.equal(f.seen.length, 0); assert.equal((await f.characters.read(f.petID)).revision, 0);
});

test('terminal candidate publication is ordered with saved model-route mutations', async t => {
  const f = await fixture(t), request = await f.preview();
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  f.models.withChatPublication = async (_route, _effort, publish) => {
    entered(); await new Promise<void>(resolve => { release = resolve; }); return publish();
  };
  const generating = f.learning.generate(request);
  const boundary = await Promise.race([ready.then(() => 'locked'), generating.then(() => 'returned')]);
  assert.equal(boundary, 'locked');
  f.learning.cancelLive('longmei'); release();
  assert.deepEqual(await generating, { ok: false, error: 'cancelled' });
  assert.equal((await f.characters.read(f.petID)).revision, 0);
});

test('a disconnected preview cancels the corresponding ticket and exposes no source', async t => {
  const f = await fixture(t), { ticket } = await f.issue();
  const input = { petID: f.petID, ticket };
  const signal = AbortSignal.abort();
  assert.deepEqual(await f.learning.preview(input, signal), { ok: false, error: 'cancelled' });
  assert.equal((await f.learning.preview(input)).ok, false);
  assert.equal(f.calls(), 0);
});

test('candidate text identical to a short source reply cannot be saved', async t => {
  const f = await fixture(t);
  const reply = '回复保持简短，优先给出重点。';
  const { ticket } = await f.learning.issueLiveTurn({ ...f.turn(), assistant: reply });
  const selected = await f.learning.preview({ petID: f.petID, ticket }); assert.ok(selected.ok);
  f.output(valid);
  assert.deepEqual(await f.learning.generate({ petID: f.petID, ticket, confirmation: selected.preview.confirmation,
    expectedRevision: selected.preview.revision, confirmed: true }), { ok: false, error: 'invalid-candidate' });
  assert.equal((await f.characters.read(f.petID)).revision, 0);
});

test('an instance whose package changes after preview cannot dispatch its old ticket', async t => {
  const f = await fixture(t), request = await f.preview();
  // Synthetic workspace fixture changes the registered package while retaining the instance ID.
  const filename = join(f.root, 'workspace', 'workspace-state.json');
  const snapshot = JSON.parse(await readFile(filename, 'utf8'));
  snapshot.registry.instances[0].package.version = '99.0.0';
  snapshot.revision++;
  await writeFile(filename, JSON.stringify(snapshot));
  assert.deepEqual(await f.learning.generate(request), { ok: false, error: 'conflict' });
  assert.equal(f.calls(), 0); assert.equal((await f.characters.read(f.petID)).revision, 0);
});

test('cancelling after candidate publication starts does not claim that nothing was written', async t => {
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const proceed = new Promise<void>(resolve => { resume = resolve; });
  const f = await fixture(t, { io: { rename: async (from, to) => { enter(); await proceed; await rename(from, to); } } });
  const request = await f.preview();
  const generation = f.learning.generate(request);
  try {
    await entered;
    assert.deepEqual(f.learning.cancel({ petID: request.petID, ticket: request.ticket }), { ok: false, error: 'write-outcome-unknown' });
  } finally { resume(); await generation; }
  assert.deepEqual(await generation, { ok: false, error: 'write-outcome-unknown' });
  assert.equal((await f.characters.read(f.petID)).memories.length, 1);
});
