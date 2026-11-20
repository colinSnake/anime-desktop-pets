import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CharacterRepository } from '../../apps/app-service/src/characters/repository.ts';
import { ModelManagement } from '../../apps/app-service/src/models/management.ts';
import { PetWorkspace } from '../../apps/app-service/src/pet-workspace.ts';
import { createService } from '../../apps/app-service/src/server.ts';
import { configuration } from '../../apps/app-service/test/fixtures/models.ts';
import { syntheticVault } from '../../apps/app-service/test/fixtures/secure-models.ts';

const pkg = { id: 'local.pet', version: '1.0.0' };
const key = 'SYNTHETIC-HARNESS-KEY', memory = '服务侧已授权的纸船记忆';
const user = '服务侧合成历史提问', assistant = '服务侧合成历史答复';
const baseURL = 'https://harness-fixture.invalid/v1';

// Actual authenticated chat handler and model adapters; only the model transport is synthetic.
export function createSdkChatFixture(root) {
  const { backend } = syntheticVault();
  let active;
  const models = new ModelManagement(join(root, 'models'), backend, undefined, {
    fetch: async (url, init) => {
      const turn = active;
      assert(turn);
      turn.calls++;
      try {
        assert.equal(url, `${baseURL}/chat/completions`);
        assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${key}`);
        const sent = JSON.parse(init.body);
        assert.equal(sent.model, 'synthetic-model');
        assert.equal(sent.tools, undefined);
        assert.deepEqual(sent.messages.slice(-3, -1), [{ role: 'user', content: user }, { role: 'assistant', content: assistant }]);
        const content = sent.messages.at(-1).content;
        if (turn.expectMemory) assert.deepEqual(JSON.parse(content), { question: turn.input.text, characterContext: { personalMemories: [memory] } });
        else assert.equal(content, turn.input.text);
        assert(!JSON.stringify(sent).includes('<system-reminder>'));
      } catch (error) { turn.fetchAssertion = error; throw error; }
      turn.dispatched.resolve();
      if (turn.mode === 'disconnect') throw new Error('synthetic provider disconnected');
      if (turn.mode === 'text') return Response.json({ choices: [{ message: { role: 'assistant', content: turn.reply }, finish_reason: 'stop' }] });
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => { turn.aborted = true; reject(new Error('synthetic provider aborted')); }, { once: true });
      });
    },
  });
  const workspace = new PetWorkspace({ root, catalog: [{ ...pkg, name: '合成桌宠' }] });
  const characters = new CharacterRepository(join(root, 'characters'));
  const token = randomBytes(32).toString('hex');
  const status = () => ({ kind: 'diagnostic', status: 'idle', detail: '' });
  const app = createService({ token, models, workspace, characters, runtime: { snapshot: status, probe: async () => status(), close: async () => {} },
    chatRuntime: async (text, complete, signal) => {
      const turn = active;
      assert(turn);
      assert.equal(text, turn.input.text);
      const { petID, requestID, route } = turn.input;
      try {
        const { finalText, ...evidence } = await turn.startWorker({ capability: randomBytes(24).toString('hex'), text, request: complete, signal,
          dispatched: turn.dispatched.promise, replyMarker: turn.reply,
          privateMarkers: [user, assistant, memory, key, baseURL, token, petID, requestID, route.fingerprint, route.connectionID, route.modelEntryID, 'synthetic-model'] });
        turn.evidence = evidence;
        // Stop, crash, timeout or Provider error have no completed text terminal.
        if (finalText === undefined) throw new Error('runtime did not complete');
        return finalText;
      } catch (error) { if (!turn.evidence) turn.failed = error; throw error; }
    },
  });
  const send = input => app.inject({ method: 'POST', url: '/v1/chat/send', headers: { host: '127.0.0.1', authorization: `Bearer ${token}` }, payload: input });
  let petID, route;
  return {
    async initialize() {
      const added = await workspace.mutate('add', { expectedRevision: 0, package: pkg });
      assert(added.ok);
      petID = added.workspace.instances[0].id;
      const { revision, credentialRef, ...connection } = configuration().connections[0];
      assert((await models.run('save', { connection: { ...connection, baseURL }, expectedRevision: 0, credential: { kind: 'replace', key } })).ok);
      [{ route }] = await models.listChatModels();
      const addedMemory = await characters.apply(petID, 0, { type: 'addMemory', value: { kind: '事实', text: memory, source: '', citation: '', version: '' } });
      const id = addedMemory.state.memories[0].current.id;
      await characters.apply(petID, 1, { type: 'confirmMemory', id });
      await characters.apply(petID, 2, { type: 'setMemoryChatShare', id, enabled: true });
    },
    async run(mode, startWorker, { text = mode === 'text' ? '聊聊纸船。\n纸船记忆。' : '关于纸船记忆', expectMemory = true } = {}) {
      const input = { requestID: randomUUID(), petID, route, text, history: [{ user, assistant }] };
      // The SDK child does not know this value before the Provider SSE arrives.
      const turn = active = { mode, input, expectMemory, reply: `合成模型回复：${randomUUID()}`, calls: 0, aborted: false, dispatched: Promise.withResolvers(), startWorker };
      try {
        const response = await send(input);
        if (turn.fetchAssertion) throw turn.fetchAssertion;
        if (turn.failed) throw turn.failed;
        assert(turn.evidence, 'missing SDK worker evidence');
        if (mode === 'text') assert.deepEqual(response.json(), { ok: true, requestID: input.requestID, text: turn.reply, replayable: !expectMemory });
        else assert.deepEqual(response.json(), { ok: false, error: 'upstream_unavailable' });
        assert.deepEqual((await send(input)).json(), { ok: false, error: 'invalid_request' });
        assert.equal(turn.calls, 1);
        assert.equal(turn.aborted, ['stop', 'crash', 'timeout', 'host-loss'].includes(mode));
        return { ...turn.evidence, serviceOutcome: mode === 'text' ? 'runtime-reply' : 'no-reply', providerDispatches: turn.calls, providerAborted: turn.aborted, replayRejected: true };
      } finally { active = undefined; }
    },
    close: () => app.close(),
  };
}
