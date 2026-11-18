import assert from 'node:assert/strict';
import test from 'node:test';
import { requestIdentity, requestCharacterRecords, requestLocalChatContext } from '../src/character-transport.ts';
import { validIdentityInput } from '../../../packages/contracts/src/characters.ts';

const connection = { port: 19276, token: 'a'.repeat(64) };
const input = { petID: 'pet-synthetic' };
const snapshot = { schemaVersion: 1, petID: input.petID, revision: 0, identity: null, identityHistory: [] };
const unavailable = { ok: false, error: 'unavailable' };

test('identity transport accepts only a registered-ID shaped input and targets the fixed loopback endpoint', async () => {
  assert.equal(validIdentityInput(input), true);
  assert.equal(validIdentityInput({ ...input, path: '/tmp/private' }), false);
  const request: typeof fetch = async (url, init) => {
    assert.equal(String(url), 'http://127.0.0.1:19276/v1/characters/pet-synthetic/identity');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${connection.token}`);
    return Response.json(snapshot);
  };
  assert.deepEqual(await requestIdentity(connection, input, request), { ok: true, snapshot });
  assert.deepEqual(await requestIdentity(connection, { petID: '../private' }, async () => assert.fail('invalid ID reached transport')), unavailable);
});

test('identity transport rejects stale/mismatched or oversized replies and masks private errors', async () => {
  assert.deepEqual(await requestIdentity(connection, input, async () => Response.json({ ...snapshot, petID: 'other-pet' })), unavailable);
  assert.deepEqual(await requestIdentity(connection, input, async () => Response.json({ ...snapshot, memories: [] })), unavailable);
  assert.deepEqual(await requestIdentity(connection, input, async () => new Response(`"${'x'.repeat(1_049_000)}"`, { headers: { 'content-type': 'application/json' } })), unavailable);
  assert.deepEqual(await requestIdentity(connection, input, async () => Response.json({ error: 'instance_not_registered' }, { status: 404 })), { ok: false, error: 'not-found' });
  assert.deepEqual(await requestIdentity(connection, input, async () => Response.json({ error: '/tmp/private' }, { status: 503 })), unavailable);
});

test('identity write transport sends only fixed fields and never retries a lost acknowledgement', async () => {
  const { writeIdentity } = await import('../src/character-transport.ts');
  const draft = { name: '合成', role: '', background: '', personality: '', values: '', motivations: '', relationship: '', speakingStyle: '', knowledgeScope: '', boundaries: '' };
  const save = { ...input, expectedRevision: 0, draft };
  let calls = 0;
  const transport: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), 'http://127.0.0.1:19276/v1/characters/pet-synthetic/identity/save');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { expectedRevision: 0, draft });
    throw Error('synthetic disconnect');
  };
  assert.deepEqual(await writeIdentity(connection, 'saveIdentity', save, transport), { ok: false, error: 'write-outcome-unknown' });
  assert.equal(calls, 1);
  assert.deepEqual(await writeIdentity(connection, 'saveIdentity', { ...save, path: '/private' }, transport), { ok: false, error: 'invalid' });
  assert.equal(calls, 1);
  assert.deepEqual(await writeIdentity(connection, 'saveIdentity', save, async () => Response.json({ ok: false, error: 'conflict' }, { status: 409 })), { ok: false, error: 'conflict' });
  assert.deepEqual(await writeIdentity(connection, 'saveIdentity', save, async () => Response.json({ ok: true, snapshot, durability: 'confirmed' })), { ok: false, error: 'write-outcome-unknown' });
});

test('record transport fixes the target, validates scoped replies and never replays writes', async () => {
  const { requestCharacterRecords } = await import('../src/character-transport.ts');
  const memories = { schemaVersion: 1, petID: input.petID, revision: 0, records: [] };
  const noDispatch: typeof fetch = async () => assert.fail('invalid input reached transport');
  assert.deepEqual(await requestCharacterRecords(connection, 'readMemories', { ...input, url: 'https://example.invalid' }, noDispatch), unavailable);
  assert.deepEqual(await requestCharacterRecords(connection, 'readMemories', input, async (url, init) => {
    assert.equal(String(url), 'http://127.0.0.1:19276/v1/characters/pet-synthetic/memories');
    assert.equal(init?.redirect, 'error');
    return Response.json(memories);
  }), { ok: true, snapshot: memories });
  assert.deepEqual(await requestCharacterRecords(connection, 'readMemories', input, async () => Response.json({ ...memories, goals: [] })), unavailable);
  const goalInput = { ...input, expectedRevision: 0, draft: { title: '合成目标', details: '', status: '进行中', steps: [] } };
  const unknown = { ok: false, error: 'write-outcome-unknown' };
  let calls = 0;
  const failed = await requestCharacterRecords(connection, 'addGoal', goalInput, async (url, init) => {
    calls++;
    assert.equal(String(url), 'http://127.0.0.1:19276/v1/characters/pet-synthetic/goals/add');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { expectedRevision: 0, draft: goalInput.draft });
    throw Error('/private/synthetic');
  });
  assert.deepEqual(failed, unknown);
  assert.equal(calls, 1);
  assert.deepEqual(await requestCharacterRecords(connection, 'addGoal', goalInput, async () => Response.json({ ok: true, snapshot: { ...memories, petID: 'other-pet', revision: 1 }, durability: 'confirmed' })), unknown);
  assert.deepEqual(await requestCharacterRecords(connection, 'addGoal', goalInput, async () => Response.json({ ok: false, error: 'conflict' }, { status: 200 })), unknown);
});

test('memory history transport is read-only, bounded and bound to the requested pet and memory', async () => {
  const { requestCharacterRecords } = await import('../src/character-transport.ts');
  const id = 'ac34fb45-1234-1234-1234-123456789abc';
  const scope = { ...input, id };
  const stamp = '2026-11-18T12:00:00.000Z';
  const historical = { id, revision: 1, kind: '事实', text: '合成资料', status: 'candidate', source: '', citation: '', version: '', createdAt: stamp, updatedAt: stamp };
  const history = { ...scope, schemaVersion: 1, revision: 12, currentRevision: 10, history: [historical] };
  assert.deepEqual(await requestCharacterRecords(connection, 'readMemoryHistory', scope, async (url, init) => {
    assert.equal(String(url), `http://127.0.0.1:19276/v1/characters/pet-synthetic/memories/history/${id}`);
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.body, undefined);
    return Response.json(history);
  }), { ok: true, snapshot: history });
  for (const invalid of [{ ...history, petID: 'pet-other' }, { ...history, id: 'other' }, { ...history, history: [{ ...historical, id: 'other' }] },
    { ...history, currentRevision: 1 }, { ...history, history: [historical, historical] },
    { ...history, history: Array.from({ length: 6 }, (_, i) => ({ ...historical, revision: i + 1 })) }]) {
    assert.deepEqual(await requestCharacterRecords(connection, 'readMemoryHistory', scope, async () => Response.json(invalid)), unavailable);
  }
  assert.deepEqual(await requestCharacterRecords(connection, 'readMemoryHistory', { ...scope, id: '../history' }, async () => assert.fail('invalid ID dispatched')), unavailable);
  assert.deepEqual(await requestCharacterRecords(connection, 'readMemoryHistory', scope, async () => Response.json({ ok: false, error: 'record-not-found' }, { status: 404 })), { ok: false, error: 'record-not-found' });
  let calls = 0;
  assert.deepEqual(await requestCharacterRecords(connection, 'restoreMemory', { ...scope, expectedRevision: 12, historicalRevision: 1 }, async (url, init) => {
    calls++;
    assert.equal(String(url), 'http://127.0.0.1:19276/v1/characters/pet-synthetic/memories/restore');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { id, expectedRevision: 12, historicalRevision: 1 });
    throw Error('acknowledgement lost');
  }), { ok: false, error: 'write-outcome-unknown' });
  assert.equal(calls, 1);
});

test('knowledge transport posts a bounded lookup without putting the query in the URL and accepts only the requested scope', async () => {
  const { requestKnowledgeSearch } = await import('../src/character-transport.ts');
  const id = '00000000-0000-0000-0000-000000000001';
  const scope = { ...input, expectedRevision: 7, query: '合成图鉴' };
  const reply = { ok: true, petID: input.petID, revision: 7, ids: [id] };
  assert.deepEqual(await requestKnowledgeSearch(connection, scope, async (url, init) => {
    assert.equal(String(url), 'http://127.0.0.1:19276/v1/characters/pet-synthetic/memories/search');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${connection.token}`);
    assert.deepEqual(JSON.parse(String(init?.body)), { expectedRevision: 7, query: scope.query });
    return Response.json(reply);
  }), reply);
  for (const response of [{ ...reply, petID: 'pet-other' }, { ...reply, revision: 6 }, { ...reply, ids: [id, id] }, { ...reply, query: scope.query }]) {
    assert.deepEqual(await requestKnowledgeSearch(connection, scope, async () => Response.json(response)), unavailable);
  }
  assert.deepEqual(await requestKnowledgeSearch(connection, scope, async () => Response.json({ ok: false, error: 'conflict' })), unavailable);
  assert.deepEqual(await requestKnowledgeSearch(connection, scope, async () => Response.json({ ok: false, error: 'conflict' }, { status: 409 })), { ok: false, error: 'conflict' });
  assert.deepEqual(await requestKnowledgeSearch(connection, scope, async () => new Response(`"${'x'.repeat(2049)}"`, { headers: { 'content-type': 'application/json' } })), unavailable);
  assert.deepEqual(await requestKnowledgeSearch(connection, { ...scope, url: 'https://example.invalid' }, async () => assert.fail('extra field dispatched')), { ok: false, error: 'invalid' });
});

test('record deletion uses fixed commands and rejects acknowledgements that still contain the deleted ID', async () => {
  const id = '00000000-0000-0000-0000-000000000001';
  const scope = { ...input, id, expectedRevision: 5 };
  const stamp = '2026-11-18T00:00:00.000Z';
  const reply = (records: unknown[]) => ({ ok: true, snapshot: { schemaVersion: 1, petID: input.petID, revision: 6, records }, durability: 'confirmed' });
  for (const [action, path] of [['deleteMemory', 'memories/delete'], ['deleteGoal', 'goals/delete']] as const) {
    assert.deepEqual(await requestCharacterRecords(connection, action, { ...scope, url: '/private' }, async () => assert.fail()), { ok: false, error: 'invalid' });
    assert.deepEqual(await requestCharacterRecords(connection, action, scope, async (url, init) => {
      assert.equal(String(url), `http://127.0.0.1:19276/v1/characters/pet-synthetic/${path}`);
      assert.equal(init?.method, 'POST');
      assert.deepEqual(JSON.parse(String(init?.body)), { id, expectedRevision: 5 });
      return Response.json(reply([]));
    }), reply([]));
  }
  const stillPresent = { id, revision: 1, createdAt: stamp, updatedAt: stamp, title: '合成标题', details: '', status: '进行中', steps: [] };
  assert.deepEqual(await requestCharacterRecords(connection, 'deleteGoal', scope, async () => Response.json(reply([stillPresent]))), { ok: false, error: 'write-outcome-unknown' });
});

test('chat context transport keeps queries out of URLs and rejects other instances and oversized replies', async () => {
  const scope = { ...input, intent: 'knowledge', query: '合成知识' } as const;
  const reply = { ok: true, petID: input.petID, text: '合成回答' };
  const intercepted: typeof fetch = async (url, init) => {
    assert.equal(String(url), 'http://127.0.0.1:19276/v1/characters/pet-synthetic/chat/local-context');
    assert.deepEqual(JSON.parse(String(init?.body)), { intent: 'knowledge', query: '合成知识' });
    assert.equal(init?.redirect, 'error');
    return Response.json(reply);
  };
  assert.deepEqual(await requestLocalChatContext(connection, scope, intercepted), reply);
  assert.deepEqual(await requestLocalChatContext(connection, scope, async () => Response.json({ ...reply, petID: 'pet-other' })), unavailable);
  assert.deepEqual(await requestLocalChatContext(connection, scope, async () => Response.json({ ...reply, text: '界'.repeat(10_000) })), unavailable);
  assert.deepEqual(await requestLocalChatContext(connection, { ...scope, header: 'synthetic' }, async () => assert.fail()), { ok: false, error: 'invalid' });
});

test('chat sharing transports reject fields and acknowledgements outside the requested record grant', async () => {
  const { writeIdentity } = await import('../src/character-transport.ts');
  const identityInput = { ...input, expectedRevision: 1, enabled: true };
  assert.deepEqual(await writeIdentity(connection, 'setIdentityChatShare', { ...identityInput, path: 'private' }, async () => assert.fail('unexpected transport')), { ok: false, error: 'invalid' });
  const at = '2026-11-18T00:00:00.000Z';
  const identity = { name: '合成角色', role: '', background: '', personality: '', values: '', motivations: '', relationship: '', speakingStyle: '', knowledgeScope: '', boundaries: '', revision: 1, createdAt: at, updatedAt: at };
  const granted = { ok: true, snapshot: { ...snapshot, revision: 2, identity: { ...identity, chatShare: true } }, durability: 'confirmed' };
  assert.deepEqual(await writeIdentity(connection, 'setIdentityChatShare', identityInput, async (url, options) => {
    assert.equal(String(url), 'http://127.0.0.1:19276/v1/characters/pet-synthetic/identity/chat-share');
    assert.deepEqual(JSON.parse(String(options?.body)), { expectedRevision: 1, enabled: true });
    return Response.json(granted);
  }), granted);
  assert.deepEqual(await writeIdentity(connection, 'setIdentityChatShare', identityInput,
    async () => Response.json({ ...granted, snapshot: { ...granted.snapshot, identity } })), { ok: false, error: 'write-outcome-unknown' });
  const id = '00000000-0000-0000-0000-000000000009';
  const record = { id, title: '合成目标', details: '', status: '进行中', steps: [], revision: 1, createdAt: at, updatedAt: at, chatShare: true };
  const result = { ok: true, snapshot: { schemaVersion: 1, petID: input.petID, revision: 2, records: [record] }, durability: 'confirmed' };
  const transport: typeof fetch = async (url, options) => {
    assert.equal(String(url), 'http://127.0.0.1:19276/v1/characters/pet-synthetic/goals/chat-share');
    assert.deepEqual(JSON.parse(String(options?.body)), { expectedRevision: 1, enabled: true, id });
    return Response.json(result);
  };
  assert.deepEqual(await requestCharacterRecords(connection, 'setGoalChatShare', { ...identityInput, id }, transport), result);
  assert.deepEqual(await requestCharacterRecords(connection, 'setGoalChatShare', { ...identityInput, id, enabled: false }, async () => Response.json(result)), { ok: false, error: 'write-outcome-unknown' });
});
