import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { requestAgentTask } from '../../desktop/src/agent-task-transport.ts';
import { agentTaskPath } from '../../../packages/contracts/src/agent-tasks.ts';
import { AgentTaskStore } from '../src/agent/task-store.ts';
import { ModelManagement } from '../src/models/management.ts';
import { PetWorkspace } from '../src/pet-workspace.ts';
import { createService } from '../src/server.ts';
import { configuration } from './fixtures/models.ts';
import { syntheticVault } from './fixtures/secure-models.ts';

const token = 'a'.repeat(64), headers = { host: '127.0.0.1', authorization: `Bearer ${token}` };
const setup = async (t: test.TestContext, fetch: typeof globalThis.fetch, toolStatus: 'supported' | 'unknown' | 'unsupported' = 'supported') => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'pet-task-service-')));
 const { backend } = syntheticVault();
 const models = new ModelManagement(join(root, 'models'), backend, undefined, { fetch });
 const { revision, credentialRef, ...connection } = configuration().connections[0]!;
 connection.models[0]!.capabilities.tools = { status: toolStatus, source: 'user' };
 assert.ok((await models.run('save', { connection, expectedRevision: 0, credential: { kind: 'replace', key: 'SYNTHETIC-TASK-KEY-128' } })).ok);
 const [option] = await models.listChatModels(); assert.ok(option);
 const pkg = { id: 'local.pet', version: '1.0.0' };
 const workspace = new PetWorkspace({ root, catalog: [{ ...pkg, name: '合成桌宠' }] });
 const first = await workspace.mutate('add', { expectedRevision: 0, package: pkg }); assert.ok(first.ok);
 const second = await workspace.mutate('add', { expectedRevision: 1, package: pkg }); assert.ok(second.ok);
 const [pet, other] = second.workspace.instances; assert.ok(pet && other);
 const snapshot = () => ({ kind: 'diagnostic' as const, status: 'idle' as const, detail: '' });
 const app = createService({ token, models, workspace, agentTasks: new AgentTaskStore(root), runtime: { snapshot, probe: async () => snapshot(), close: async () => {} } });
 t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
 const input = { petID: pet.id, taskID: randomUUID(), route: option.route, prompt: '读这份文件', files: [{ name: 'notes.txt', mediaType: 'text/plain' as const, data: '5L2g5aW9' }] };
 const send = (method: 'create' | 'read' | 'cancel', payload: object) => app.inject({ url: agentTaskPath(method), method: 'POST', headers, payload });
 const owner = { petID: input.petID, taskID: input.taskID };
 const until = async (status: string) => {
  for (let i = 0; i < 100; i++) {
   const response = await send('read', owner); assert.equal(response.statusCode, 200);
   const { task } = response.json(); if (task.status === status) return task;
   await delay(20);
  }
  assert.fail(`task did not become ${status}`);
 };
 return { app, root, models, option, input, other, send, owner, until };
};

test('agent task admission accepts explicit full permission without widening the fixed tool boundary', async t => {
 const outbound: string[] = [];
 const f = await setup(t, async (_url, init) => {
  outbound.push(String(init?.body));
  return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '待审结果' } }] });
 });
 const input = { ...f.input, taskID: randomUUID(), executionPermission: { mode: 'full' as const } };
 assert.equal((await f.send('create', input)).statusCode, 200);
 assert.equal((await f.send('read', { petID: input.petID, taskID: input.taskID })).statusCode, 200);
 for (let i = 0; i < 100; i++) {
  const response = await f.send('read', { petID: input.petID, taskID: input.taskID });
  assert.equal(response.statusCode, 200);
  const task = response.json().task;
  if (task.status === 'completed') { assert.equal(task.result, '待审结果'); break; }
  await delay(20);
  if (i === 99) assert.fail('full permission task did not complete');
 }
 assert.equal(outbound.length, 1);
 assert.match(outbound[0]!, /只能输出供用户审阅/);
 assert.doesNotMatch(outbound[0]!, /\"name\":\"(?:shell|run_command|write_file)\"/);
});

test('fixed service routes run an isolated tool task on its pinned provider and refuse cross-pet reads', async t => {
 const outbound: string[] = [];
 const f = await setup(t, async (_url, init) => {
  outbound.push(String(init?.body));
  if (outbound.length === 1) return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
   tool_calls: [{ id: 'call-one', type: 'function', function: { name: 'read_task_file', arguments: '{"file":1,"offset":0}' } }] } }] });
  return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '待审结果' } }] });
 });
 assert.equal((await f.send('create', f.input)).statusCode, 200);
 assert.equal((await f.send('read', { ...f.owner, petID: f.other.id })).statusCode, 404);
 assert.equal((await f.send('create', f.input)).statusCode, 409);
 assert.equal((await f.until('completed')).result, '待审结果');
 assert.equal(outbound.length, 2);
 assert.doesNotMatch(outbound[0]!, /你好|5L2g5aW9|SYNTHETIC-TASK-KEY|合成桌宠/);
 assert.match(outbound[1]!, /你好/);
});

const toolReply = (name: string, args: string) => Response.json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
 tool_calls: [{ id: 'call-one', type: 'function', function: { name, arguments: args } }] } }] });
const textReply = (content: string) => Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] });

test('an unknown saved model starts the authorised task directly, without a charged tool probe', async t => {
 const outbound: string[] = [];
 const f = await setup(t, async (_url, init) => {
  outbound.push(String(init?.body));
  return outbound.length === 1 ? toolReply('read_task_file', '{"file":1,"offset":0}') : textReply('待审结果');
 }, 'unknown');
 assert.equal(f.option.taskTools, 'unverified');
 assert.equal(outbound.length, 0);
 assert.equal((await f.send('create', f.input)).statusCode, 200);
 assert.equal((await f.until('completed')).result, '待审结果');
 assert.equal(outbound.length, 2);
 assert.match(outbound[0]!, /读这份文件/);
 assert.doesNotMatch(outbound[0]!, /verify_task_tools|notes.txt|你好/);
 assert.match(outbound[1]!, /你好/);
});

test('unknown routes requesting an unapproved tool receive no material or continuation', async t => {
 const outbound: string[] = [];
 const f = await setup(t, async (_url, init) => {
  outbound.push(String(init?.body));
  return toolReply('shell', '{}');
 }, 'unknown');
 assert.equal((await f.send('create', f.input)).statusCode, 200);
 assert.equal((await f.until('failed')).error, 'provider_failed');
 assert.equal(outbound.length, 1);
 assert.doesNotMatch(outbound[0]!, /verify_task_tools|notes.txt|你好/);
});

test('an explicitly unsupported model never dispatches a task or a tool check', async t => {
 const f = await setup(t, async () => assert.fail('unsupported must not dispatch'), 'unsupported');
 assert.equal(f.option.taskTools, undefined);
 assert.deepEqual((await f.send('create', f.input)).json(), { ok: false, error: 'tools_unavailable' });
});

test('cancelling a registered attempt aborts its provider and never publishes a late answer', async t => {
 let opened!: () => void;
 const entered = new Promise<void>(resolve => { opened = resolve; });
 let signal: AbortSignal | null | undefined;
 const f = await setup(t, async (_url, init) => {
  signal = init?.signal;
  opened();
  return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
 });
 assert.equal((await f.send('create', f.input)).statusCode, 200);
 await entered;
 assert.equal((await f.send('cancel', f.owner)).statusCode, 200);
 assert.equal(signal?.aborted, true);
 assert.equal((await f.until('cancelled')).result, undefined);
});

test('stale task routing is rejected before dispatch and does not create a queued attempt', async t => {
 const f = await setup(t, async () => assert.fail('stale route must not dispatch'));
 const create = await f.send('create', { ...f.input, route: { ...f.input.route, fingerprint: 'b'.repeat(64) } });
 assert.equal(create.statusCode, 409);
 assert.deepEqual(create.json(), { ok: false, error: 'route_changed' });
 assert.equal((await f.send('read', f.owner)).statusCode, 404);
});


test('an opaque Key pasted into a task instruction never reaches the provider, SQLite or a task reply', async t => {
 let dispatches = 0;
 const f = await setup(t, async () => { dispatches++; return Response.json({}); });
 const prompt = 'SYNTHETIC-TASK-KEY-128';
 const response = await f.send('create', { ...f.input, prompt });
 assert.equal(response.statusCode, 200);
 assert.doesNotMatch(response.body, /SYNTHETIC-TASK-KEY-128/);
 assert.equal((await f.until('failed')).result, undefined);
 assert.equal(dispatches, 0);
 assert.equal((await readFile(join(f.root, 'agent-tasks.sqlite'))).includes(prompt), false);
});

test('retiring an instance aborts the owned provider request and denies subsequent public task access', async t => {
 let opened!: () => void;
 const entered = new Promise<void>(resolve => { opened = resolve; });
 let signal: AbortSignal | null | undefined;
 const f = await setup(t, async (_url, init) => {
  signal = init?.signal; opened();
  return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
 });
 assert.equal((await f.send('create', f.input)).statusCode, 200);
 await entered;
 assert.equal((await f.app.inject({ url: '/v1/pets/delete', method: 'POST', headers,
  payload: { expectedRevision: 2, id: f.input.petID } })).statusCode, 200);
 assert.equal(signal?.aborted, true);
 assert.equal((await f.send('read', f.owner)).statusCode, 404);
 assert.equal((await f.send('cancel', f.owner)).statusCode, 404);
});


test('an aborted desktop loopback create cannot start while service admission is still in flight', { timeout: 5000 }, async t => {
 const f = await setup(t, async () => assert.fail('a disconnected caller must not dispatch'));
 const latch = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
 };
 const reached = latch(), closed = latch(), allow = latch();
 const assertRoute = f.models.assertChatRoute.bind(f.models);
 f.models.assertChatRoute = async route => {
  reached.resolve(); await allow.promise;
  return assertRoute(route);
 };
 f.app.addHook('onRequest', async (request, reply) => {
  if (request.url === agentTaskPath('create')) reply.raw.once('close', () => closed.resolve());
 });
 await f.app.listen({ host: '127.0.0.1', port: 0 });
 const address = f.app.server.address(); assert.ok(address && typeof address !== 'string');
 const session = { port: address.port, token };
 const stop = new AbortController();
 const pending = requestAgentTask(session, 'create', f.input, stop.signal);
 try {
  await reached.promise;
  stop.abort();
  assert.deepEqual(await pending, { ok: false, error: 'unavailable' });
  await closed.promise;
 } finally { allow.resolve(); }
 assert.deepEqual(await requestAgentTask(session, 'read', f.owner), { ok: false, error: 'not_found' });
});
