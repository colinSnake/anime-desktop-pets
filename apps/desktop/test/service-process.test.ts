import assert from "node:assert/strict";
import test from "node:test";
import { fork, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import {
  ServiceProcess,
  type ServiceTransport,
} from "../src/service-process.ts";

const guardianPath = resolve("apps/runtime-bridge/guardian.py");
function transport(child: ChildProcess): ServiceTransport {
  return {
    send: (message) => {
      child.send(message as object);
    },
    onMessage: (handler) => {
      child.on("message", handler);
    },
    onExit: (handler) => {
      child.once("exit", handler);
    },
    terminate: () => {
      child.kill();
    },
  };
}
test("starts an independent real Fastify process, probes real Python, and closes the service", async () => {
  let child: ChildProcess | undefined;
  const service = new ServiceProcess(
    () => {
      child = fork(resolve("apps/app-service/src/entry.ts"), [], {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      return transport(child);
    },
    {
      guardianPath,
      workerPath: resolve("apps/runtime-bridge/worker.py"),
      python: process.env.PET_PYTHON,
      startupMs: 5000,
    },
  );
  try {
    await service.start();
    assert.equal((await service.request("snapshot")).runtime.status, "idle");
    assert.equal((await service.request("probe")).runtime.status, "ready");
    await service.close();
    assert.ok(child && child.exitCode !== null);
    await assert.rejects(service.request("snapshot"), /unavailable/);
  } finally {
    await service.close();
  }
});
test("an unexpected service exit invalidates the connection instead of showing stale success", async () => {
  let child!: ChildProcess;
  const service = new ServiceProcess(
    () => {
      child = fork(resolve("apps/app-service/src/entry.ts"), [], {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      return transport(child);
    },
    {
      guardianPath,
      workerPath: resolve("apps/runtime-bridge/worker.py"),
      startupMs: 5000,
    },
  );
  try {
    await service.start();
    const exited = new Promise<void>((resolveExit) =>
      child.once("exit", () => resolveExit()),
    );
    child.kill();
    await exited;
    await assert.rejects(service.request("snapshot"), /unavailable/);
  } finally {
    await service.close();
  }
});
test("handshake timeout terminates only the owned service and rejects late readiness", async () => {
  let exit!: () => void;
  let receive!: (message: unknown) => void;
  let terminated = false;
  const service = new ServiceProcess(
    () => ({
      send() {},
      onMessage(handler) {
        receive = handler;
      },
      onExit(handler) {
        exit = handler;
      },
      terminate() {
        terminated = true;
        exit();
      },
    }),
    { guardianPath, workerPath: "unused", startupMs: 20, shutdownMs: 20 },
  );
  await assert.rejects(service.start(), /unavailable/);
  assert.equal(terminated, true);
  receive({ type: "ready", port: 12345 });
  await assert.rejects(service.request("snapshot"), /unavailable/);
  await service.close();
});

test("shutdown cancels an in-flight Python probe and reaps the worker before service exit", async () => {
  let child!: ChildProcess;
  const service = new ServiceProcess(
    () => {
      child = fork(resolve("apps/app-service/src/entry.ts"), [], {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      return transport(child);
    },
    {
      guardianPath,
      workerPath: resolve("apps/app-service/test/fixtures/runtime-fixture.py"),
      startupMs: 5000,
    },
  );
  try {
    await service.start();
    const pending = service.request("probe").catch(() => undefined);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 60));
    await service.close();
    await pending;
    assert.ok(child.exitCode !== null);
  } finally {
    await service.close();
  }
});

import { appendFile, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("service death reaps a hung Python worker independently of the dead service", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pet-parent-death-"));
  const worker = join(directory, "hung.py");
  const pidFile = join(directory, "worker.pid");
  await writeFile(
    worker,
    `import os, time, signal\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nwith open(${JSON.stringify(pidFile)}, 'w') as output:\n    output.write(str(os.getpid()))\ntime.sleep(30)\n`,
  );
  let child!: ChildProcess;
  let workerPID: number | undefined;
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const service = new ServiceProcess(
    () => {
      child = fork(resolve("apps/app-service/src/entry.ts"), [], {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      return transport(child);
    },
    { guardianPath, workerPath: worker, startupMs: 5000 },
  );
  let pending: Promise<unknown> | undefined;
  try {
    await service.start();
    pending = service.request("probe").catch(() => undefined);
    const startedBy = Date.now() + 3000;
    while (!workerPID && Date.now() < startedBy) {
      try {
        workerPID = Number(await readFile(pidFile, "utf8"));
      } catch {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
    }
    assert.ok(workerPID && alive(workerPID));
    const exited = new Promise<void>((resolveExit) =>
      child.once("exit", () => resolveExit()),
    );
    child.kill("SIGKILL");
    await exited;
    await service.close();
    const reapedBy = Date.now() + 2000;
    while (alive(workerPID) && Date.now() < reapedBy)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    assert.equal(
      alive(workerPID),
      false,
      "hung worker outlived its application service",
    );
  } finally {
    await service.close();
    if (workerPID && alive(workerPID)) process.kill(workerPID, "SIGKILL");
    await pending;
    await rm(directory, { recursive: true, force: true });
  }
});

test("shutdown surfaces a service cleanup failure instead of reporting graceful completion", async () => {
  let receive!: (value: unknown) => void;
  let exit!: (code?: number) => void;
  const service = new ServiceProcess(() => ({
    send(value) {
      if ((value as { type: string }).type === "bootstrap") queueMicrotask(() => receive({ type: "ready", port: 12345 }));
      else queueMicrotask(() => exit(1));
    },
    onMessage(handler) { receive = handler; },
    onExit(handler) { exit = handler; },
    terminate() { assert.fail("already exited"); },
  }), { guardianPath, workerPath: resolve("apps/runtime-bridge/worker.py") });
  await service.start();
  await assert.rejects(service.close(), /cleanup/);
});

test("trusted player bootstrap reaches fixed HTTP actions while non-macOS playback stays blocked", async () => {
  const root = await mkdtemp(join(tmpdir(), "pet-service-player-"));
  const worker = join(root, "ready.py");
  await writeFile(worker, await readFile(resolve("apps/app-service/test/fixtures/player-fixture.py")));
  let child!: ChildProcess;
  const service = new ServiceProcess(() => {
    child = fork(resolve("apps/app-service/src/entry.ts"), [], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"] });
    return transport(child);
  }, { guardianPath, workerPath: resolve("apps/runtime-bridge/worker.py"), python: process.env.PET_PYTHON,
    player: { workerPath: worker, config: { source: root, assets: root, profileRoot: join(root, "sessions") } } });
  try {
    await service.start();
    const initial = await service.request("snapshot");
    assert.equal(initial.player?.status, process.platform === "darwin" ? "stopped" : "blocked");
    const started = await service.request("start-player");
    assert.equal(started.player?.status, process.platform === "darwin" ? "running" : "blocked");
    assert.equal((await service.request("stop-player")).player?.status, process.platform === "darwin" ? "stopped" : "blocked");
    assert.equal((await service.request("probe")).runtime.status, "ready");
    assert.ok(!JSON.stringify(started).includes(root));
    await service.close();
    assert.equal(child.exitCode, 0);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('fixed pet transport reaches the real isolated service and persists across service restarts', async t => {
  const { mkdtemp, realpath, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pet-service-workspace-'));
  const create = () => new ServiceProcess(() => transport(fork(resolve('apps/app-service/src/entry.ts'), [], {execArgv:['--import','tsx'],stdio:['ignore','ignore','ignore','ipc']})), {guardianPath,workerPath:resolve('apps/runtime-bridge/worker.py'),workspace:{root,catalog:[{id:'local.pet',version:'1.0.0',name:'合成桌宠'}]}});
  let service = create();
  t.after(async () => { await service.close(); await rm(root,{recursive:true,force:true}); });
  await service.start();
  const added = await service.petRequest('add',{expectedRevision:0,package:{id:'local.pet',version:'1.0.0'}}); assert.ok(added.ok);
  assert.equal(added.workspace.instances.length,1);
  await service.close(); service = create(); await service.start();
  const result = await service.petRequest('list'); assert.ok(result.ok);
  assert.equal(result.workspace.instances.length,1);
  assert.equal(result.workspace.instances[0]!.phase,'not-connected');
  await service.close();
  assert.deepEqual(await service.petRequest('list'),{ok:false,error:'unavailable'});
});

test('trusted fixed model methods roundtrip using an isolated profile without requesting credentials', { skip: process.platform !== 'darwin' }, async t => {
  const { mkdtemp, realpath, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { configuration } = await import('../../app-service/test/fixtures/models.ts');
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pet-service-models-'));
  const service = new ServiceProcess(() => transport(fork(resolve('apps/app-service/src/entry.ts'), [], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })), { guardianPath, workerPath: resolve('apps/runtime-bridge/worker.py'), modelsRoot: join(root, 'models') });
  t.after(async () => { try { await service.close(); } finally { await rm(root,{recursive:true,force:true}); } });
  await service.start();
  const { revision: _r, credentialRef: _c, ...connection } = configuration().connections[0]!;
  const first = await service.listModels(); assert.ok(first.ok); assert.equal(first.configuration.revision,0);
  const save = await service.saveModelConnection({connection,expectedRevision:0,credential:{kind:'keep'}});
  assert.ok(save.ok); assert.equal(save.configuration.connections[0]!.credentialState,'missing');
  const selected = await service.setModelDefault({expectedRevision:1,connectionID:connection.id,entryID:connection.defaultModelEntryID});
  assert.ok(selected.ok); assert.equal(selected.configuration.defaultConnectionID,connection.id);
  const removed = await service.removeModelConnection({expectedRevision:1,connectionID:connection.id,replacementDefault:null});
  assert.ok(removed.ok); assert.deepEqual(removed.configuration.connections,[]);
  await service.close();
  assert.deepEqual(await service.listModels(),{version:1,ok:false,error:'unavailable'});
});

test('macOS task reads require the fixed parent command and only owned pets receive work states', { skip: process.platform !== 'darwin' }, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pet-task-private-channel-'));
  const runtime = join(root, 'bundle', 'runtime');
  const home = join(root, 'home');
  const day = join(home, '.codex', 'sessions', '2026', '11', '18');
  await mkdir(day, { recursive: true });
  await mkdir(runtime, { recursive: true });
  const playerWorker = join(runtime, 'task-animation.py');
  const profileRoot = join(root, 'players');
  const pkg = { id: 'local.development.longmei', version: '0.0.0-dev' };
  await copyFile('apps/app-service/test/fixtures/player-fixture.py', playerWorker);
  await Promise.all(['task_reader_worker.py', 'task_reader.py'].map(name => copyFile(`apps/runtime-bridge/${name}`, join(runtime, name))));
  await copyFile('apps/pet-runtime/bailong/dragon_tasks.py', join(runtime, 'dragon_tasks.py'));
  await writeFile(join(runtime, '..', 'codex-presence'), '#!/bin/sh\nprintf "running\\n"\n', { mode: 0o700 });
  await writeFile(join(day, 'rollout-synthetic.jsonl'), [
    { type: 'session_meta', payload: { source: 'vscode' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'fixture', text: 'never sent' } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  let child!: ChildProcess;
  const states: string[] = [];
  const service = new ServiceProcess(() => {
    child = fork(resolve('apps/app-service/src/entry.ts'), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    return transport(child);
  }, { guardianPath, workerPath: join(runtime, 'worker.py'), python: process.env.PET_PYTHON, taskFollowingHome: home,
    workspace: { root: join(root, 'workspace'), catalog: [{ ...pkg, name: 'synthetic', launchable: true }] },
    player: { workerPath: playerWorker, config: { source: root, assets: root, profileRoot } },
    onTaskFollowingState: state => states.push(state) });
  t.after(async () => { try { await service.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  const settle = () => new Promise(resolve => setTimeout(resolve, 80));
  const waitForState = async (state: string) => {
    const deadline = performance.now() + 3500;
    while (states.at(-1) !== state && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(states.at(-1), state);
  };
  assert.equal(service.setTaskFollowing(true), false);
  await service.start();
  const added = await service.petRequest('add', { expectedRevision: 0, package: pkg }); assert.ok(added.ok);
  const id = added.workspace.instances[0]!.id;
  const revision = added.workspace.revision;
  assert.ok((await service.petRequest('start', { expectedRevision: revision, id })).ok);
  assert.equal((await service.request('start-player')).player?.status, 'running');
  async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
    const until = performance.now() + 5000;
    while (performance.now() < until) {
      const result = await read();
      if (result !== undefined) return result;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    assert.fail('synthetic task delivery timed out');
  }
  const ownedRoot = join(profileRoot, 'instances', id);
  const framePath = await waitFor(async () => {
    try { const [session] = await readdir(ownedRoot); return session && join(ownedRoot, session, 'task-frames.jsonl'); }
    catch { return; }
  });
  const lastTask = async () => {
    let text: string;
    try { text = await readFile(framePath, 'utf8'); } catch { return; }
    const row = text.trimEnd().split('\n').at(-1);
    return row ? (JSON.parse(row) as { task?: { state: string; startSerial: number; expiresAt: number } }).task : undefined;
  };
  await waitFor(async () => (await lastTask())?.state === 'disabled' ? true : undefined);
  child.send({ type: 'codex-task-following', enabled: true, path: home });
  await settle(); assert.deepEqual(states, []);
  assert.equal(service.setTaskFollowing(true), true);
  await waitForState('working');
  const cold = await waitFor(async () => { const task = await lastTask(); return task?.state === 'working' ? task : undefined; });
  assert.equal(cold.startSerial, 0);
  await appendFile(join(day, 'rollout-synthetic.jsonl'), JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'next', text: 'never sent' } }) + '\n');
  await waitFor(async () => (await lastTask())?.startSerial === 1 ? true : undefined);
  const diagnostic = (await readdir(profileRoot)).find(name => name.startsWith('session-'))!;
  await assert.rejects(readFile(join(profileRoot, diagnostic, 'task-frames.jsonl')), { code: 'ENOENT' });
  assert.equal(service.setTaskFollowing(false), true);
  await waitFor(async () => (await lastTask())?.state === 'disabled' ? true : undefined);
  assert.equal(service.setTaskFollowing(true), true);
  await waitForState('working');
  assert.ok((await service.petRequest('pause', { expectedRevision: revision })).ok);
  await waitForState('off');
  const paused = states.slice();
  assert.equal(service.setTaskFollowing(true), true);
  await settle(); assert.deepEqual(states, paused);
  assert.ok((await service.petRequest('resume', { expectedRevision: revision })).ok);
  await settle(); assert.deepEqual(states, paused);
  assert.equal(service.setTaskFollowing(true), true);
  await waitForState('working');
  assert.equal(service.setTaskFollowing(false), true);
  await waitForState('off');
});
