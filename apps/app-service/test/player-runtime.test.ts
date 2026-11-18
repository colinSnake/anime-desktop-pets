import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, copyFile, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PlayerRuntime } from "../src/player-runtime.ts";

const python = process.env.PET_PYTHON || (process.platform === "win32" ? "python" : "python3");
const guardianPath = resolve("apps/runtime-bridge/guardian.py");
async function fixture(mode = "ready") {
  const root = await mkdtemp(join(tmpdir(), "pet-player-test-"));
  const workerPath = join(root, `${mode}.py`);
  await copyFile(resolve("apps/app-service/test/fixtures/player-fixture.py"), workerPath);
  const runtime = new PlayerRuntime({ python, guardianPath, workerPath, platform: "darwin", timeoutMs: 1500,
    config: { source: root, assets: root, profileRoot: join(root, "sessions") } });
  return { root, runtime, cleanup: async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); } };
}
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

test("player defaults to unconfigured; Linux/Windows prepared decoders are explicitly blocked", async () => {
  const unconfigured = new PlayerRuntime({ guardianPath, workerPath: resolve("apps/runtime-bridge/player_worker.py") });
  assert.equal(unconfigured.snapshot().status, "unconfigured");
  assert.equal((await unconfigured.start()).status, "unconfigured");
  assert.equal(unconfigured.pid, undefined);
  await unconfigured.close();
  for (const platform of ["linux", "win32"] as const) {
    const runtime = new PlayerRuntime({ guardianPath, workerPath: resolve("apps/runtime-bridge/player_worker.py"), platform,
      config: { source: tmpdir(), assets: tmpdir(), profileRoot: tmpdir() } });
    assert.equal((await runtime.start()).status, "blocked");
    assert.equal(runtime.pid, undefined);
    await runtime.close();
  }
});
test("explicit start coalesces; stop reaps child and each restart gets a fresh private profile", async () => {
  const { root, runtime, cleanup } = await fixture();
  try {
    assert.equal(runtime.snapshot().status, "stopped");
    const start = runtime.start();
    assert.equal(runtime.start(), start);
    assert.equal((await start).status, "running");
    const pid = runtime.pid!;
    assert.ok(alive(pid));
    assert.equal((await runtime.stop()).status, "stopped");
    assert.equal(alive(pid), false);
    assert.equal((await runtime.start()).status, "running");
    assert.equal((await readdir(join(root, "sessions"))).length, 2);
    assert.deepEqual(Object.keys(runtime.snapshot()).sort(), ["detail", "kind", "status"]);
  } finally { await cleanup(); }
});
test("display commands are bounded, confirmed, and do not replace the owned runtime", async () => {
  const { runtime, cleanup } = await fixture();
  try {
    assert.equal((await runtime.start()).status, "running");
    assert.equal(await runtime.applyDisplayPreferences({ size: 320, hideInFullscreen: true }), true);
    assert.equal(await runtime.setVisible(false), true);
    assert.equal(await runtime.applyDisplayPreferences({ size: 500, hideInFullscreen: false }), false);
    assert.equal(runtime.snapshot().status, "running");
  } finally { await cleanup(); }
});
test("explicit startup passes only a complete saved position pair to the owned worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "pet-player-test-"));
  const workerPath = join(root, "position-bootstrap.py");
  await copyFile(resolve("apps/app-service/test/fixtures/player-fixture.py"), workerPath);
  const runtime = new PlayerRuntime({ python, guardianPath, workerPath, platform: "darwin", timeoutMs: 1500,
    config: { source: root, assets: root, profileRoot: join(root, "sessions") },
    initialPreferences: { size: 256, hideInFullscreen: true, scheduledActivity: false, movement: true, x: 100, y: -120 } });
  try {
    assert.equal((await runtime.start()).status, "running");
    const [session] = await readdir(join(root, "sessions"));
    assert.deepEqual(JSON.parse(await readFile(join(root, "sessions", session!, "bootstrap-preferences.json"), "utf8")),
      { size: 256, hideInFullscreen: true, scheduledActivity: false, movement: true, x: 100, y: -120 });
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
test("owned player reports bounded drag position feedback without treating it as a command response", async () => {
  const root = await mkdtemp(join(tmpdir(), "pet-player-test-"));
  const workerPath = join(root, "position.py");
  await copyFile(resolve("apps/app-service/test/fixtures/player-fixture.py"), workerPath);
  let received: { x: number; y: number } | undefined;
  const runtime = new PlayerRuntime({ python, guardianPath, workerPath, platform: "darwin", timeoutMs: 1500,
    config: { source: root, assets: root, profileRoot: join(root, "sessions") },
    onPosition: value => { received = value; } });
  try {
    assert.equal((await runtime.start()).status, "running");
    const deadline = Date.now() + 3000;
    while (!received && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(received, { x: 120, y: 240 });
    assert.equal(runtime.snapshot().status, "running");
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
test("owned player rejects malformed or out-of-range position events", async () => {
  const { root, runtime } = await fixture("invalid-position");
  try {
    await runtime.start();
    const deadline = Date.now() + 3000;
    while (runtime.snapshot().status !== "error" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(runtime.snapshot().status, "error");
  } finally {
    // A late protocol violation can leave cleanup unconfirmed; never demand a false clean stop.
    try { await runtime.close(); } catch (error) { assert.match((error as Error).message, /player_cleanup_timeout/); }
    await rm(root, { recursive: true, force: true });
  }
});
for (const mode of ["hang", "noisy", "wrong-id", "exit"]) {
  test(`player rejects ${mode} with sanitized state and reaps owned worker`, async () => {
    const { root, runtime, cleanup } = await fixture(mode);
    try {
      const result = await runtime.start();
      assert.equal(result.status, "error");
      assert.ok(!JSON.stringify(result).includes(root));
      const profiles = await readdir(join(root, "sessions"));
      const pid = Number(await readFile(join(root, "sessions", profiles[0]!, "worker.pid"), "utf8"));
      assert.equal(alive(pid), false);
    } finally { await cleanup(); }
  });
}
test("stop/close cancel an in-flight start, including before spawn; no late success or automatic restart", async () => {
  for (const close of [false, true]) {
    const { runtime, cleanup } = await fixture("hang");
    try {
      const start = runtime.start();
      if (close) await runtime.close(); else await runtime.stop();
      assert.equal((await start).status, "stopped");
      assert.equal(runtime.pid, undefined);
      if (close) assert.equal((await runtime.start()).status, "stopped");
    } finally { await cleanup(); }
  }
});
test("player excludes inherited credentials, task leases, and import hooks", async () => {
  const keys = ["PET_MODEL_API_KEY", "PYTHONPATH", "PET_TASK_LEASE", "BAILONG_PET_LIBRARY_DIR"];
  const previous = keys.map(key => process.env[key]);
  const { runtime, cleanup } = await fixture();
  try {
    keys.forEach(key => process.env[key] = "synthetic-secret");
    assert.equal((await runtime.start()).status, "running");
  } finally {
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    await cleanup();
  }
});
test("unexpected guardian exit is visible; missing interpreter is sanitized", async () => {
  const { runtime, cleanup } = await fixture();
  try {
    await runtime.start();
    process.kill(runtime.pid!, "SIGTERM");
    const deadline = Date.now() + 4500;
    while (runtime.snapshot().status !== "error" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(runtime.snapshot().status, "error");
    assert.equal((await runtime.start()).status, "running");
  } finally { await cleanup(); }
  const missingRoot = await mkdtemp(join(tmpdir(), "pet-player-missing-"));
  const missing = new PlayerRuntime({ guardianPath, workerPath: resolve("apps/runtime-bridge/player_worker.py"), python: join(tmpdir(), "missing-private-python"), platform: "darwin",
    config: { source: tmpdir(), assets: tmpdir(), profileRoot: missingRoot } });
  try { assert.equal((await missing.start()).status, "error"); assert.ok(!missing.snapshot().detail.includes("missing-private")); }
  finally { await missing.close(); await rm(missingRoot, { recursive: true, force: true }); }
});

test("stop cancels an already-spawned pending worker and repeated stops share cleanup", async () => {
  const { root, runtime, cleanup } = await fixture("slow-ready");
  try {
    const start = runtime.start();
    const deadline = Date.now() + 3000;
    while (!runtime.pid && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(runtime.pid);
    const pid = runtime.pid!;
    const stop = runtime.stop();
    assert.equal(runtime.stop(), stop);
    await stop;
    assert.equal((await start).status, "stopped");
    assert.equal(alive(pid), false);
    assert.ok(!JSON.stringify(runtime.snapshot()).includes(root));
  } finally { await cleanup(); }
});

test("invalid stdout is discarded without retaining unbounded bytes", async () => {
  const { root, runtime, cleanup } = await fixture();
  try {
    await runtime.start();
    const session = (runtime as unknown as { session: { child: { stdout: { emit(event: string, chunk: Buffer): void } }; buffer: Buffer } }).session;
    for (let i = 0; i < 16; i++) session.child.stdout.emit("data", Buffer.alloc(65536, 120));
    assert.ok(session.buffer.length <= 4096);
    assert.equal(runtime.snapshot().status, "error");
    await assert.rejects(runtime.close(), /cleanup/);
  } finally { await cleanup().catch(async () => { await rm(root, { recursive: true, force: true }); }); }
});

import { fork } from "node:child_process";
test("independent player guardian reaps a hung worker after owner service death", async () => {
  const { root, cleanup } = await fixture("hang");
  const owner = fork(resolve("apps/app-service/test/fixtures/player-owner.ts"), [root], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const exited = new Promise<void>(resolve => owner.once("exit", () => resolve()));
  let workerPid: number | undefined;
  let guardianPid: number | undefined;
  owner.on("message", message => { guardianPid = (message as { pid: number }).pid; });
  try {
    const deadline = Date.now() + 5000;
    while ((!workerPid || !guardianPid) && Date.now() < deadline) {
      try {
        const sessions = await readdir(join(root, "sessions"));
        workerPid = Number(await readFile(join(root, "sessions", sessions[0]!, "worker.pid"), "utf8"));
      } catch { /* wait for owned synthetic worker */ }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(workerPid && guardianPid && alive(workerPid));
    owner.kill("SIGKILL"); await exited;
    const reapedBy = Date.now() + 5000;
    while (alive(workerPid) && Date.now() < reapedBy) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(alive(workerPid), false, "hung player survived owner EOF");
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    await exited;
    if (workerPid && alive(workerPid)) process.kill(workerPid, "SIGKILL");
    if (guardianPid && alive(guardianPid)) process.kill(guardianPid, "SIGTERM");
    await cleanup();
  }
});

test("a stop without cleanup acknowledgement remains error after forced reaping, including close", async () => {
  const { root, runtime, cleanup } = await fixture("stop-hang");
  try {
    assert.equal((await runtime.start()).status, "running");
    const profiles = await readdir(join(root, "sessions"));
    const pid = Number(await readFile(join(root, "sessions", profiles[0]!, "worker.pid"), "utf8"));
    assert.equal((await runtime.stop()).status, "error");
    assert.equal(alive(pid), false);
    await assert.rejects(runtime.close(), /cleanup/);
  } finally { await cleanup().catch(async () => { await rm(root, { recursive: true, force: true }); }); }
});
test("normal local user stop is acknowledged as stopped, never an unexplained crash", async () => {
  const { runtime, cleanup } = await fixture("self-stop");
  try {
    assert.equal((await runtime.start()).status, "running");
    const deadline = Date.now() + 3000;
    while (!["stopped", "error"].includes(runtime.snapshot().status) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(runtime.snapshot().status, "stopped");
    assert.equal(runtime.pid, undefined);
  } finally { await cleanup(); }
});

test("immediate explicit restart after cancelled start creates a new operation; old finalizers cannot clear it", async () => {
  const { runtime, cleanup } = await fixture("slow-ready");
  try {
    const first = runtime.start();
    assert.equal((await runtime.stop()).status, "stopped");
    const retry = runtime.start();
    assert.notEqual(retry, first);
    assert.equal((await first).status, "stopped");
    assert.equal(runtime.start(), retry, "old cancelled operation cleared the new in-flight start");
    assert.equal((await retry).status, "running");
    assert.ok(runtime.pid);
  } finally { await cleanup(); }
});

test("behavior bootstrap and commands use owned versioned sessions with fresh saved values on restart", async () => {
 const {root,runtime,cleanup}=await fixture('behavior');
 const initial={size:256,hideInFullscreen:true,scheduledActivity:true,movement:false};
 try {
  assert.equal(await runtime.applyBehaviorPreferences({scheduledActivity:true,movement:false}),false);
  assert.equal((await runtime.start(initial)).status,'running');
  const profiles=await readdir(join(root,'sessions'));
  const read=(profile:string,name:string)=>readFile(join(root,'sessions',profile,name),'utf8').then(JSON.parse);
  assert.deepEqual(await read(profiles[0]!,'bootstrap-preferences.json'),initial);
  assert.equal(await runtime.applyBehaviorPreferences({scheduledActivity:false,movement:true}),true);
  assert.deepEqual(await read(profiles[0]!,'behavior-command.json'),{scheduledActivity:false,movement:true});
  assert.equal(await runtime.applyBehaviorPreferences({scheduledActivity:true,movement:1} as never),false);
  assert.equal(await runtime.applyBehaviorPreferences({scheduledActivity:true,movement:true,taskActive:false} as never),false);
  await runtime.stop();
  const next={...initial,scheduledActivity:false,movement:true};await runtime.start(next);
  const restarted=(await readdir(join(root,'sessions'))).find(p=>p!==profiles[0])!;
  assert.deepEqual(await read(restarted,'bootstrap-preferences.json'),next);
 } finally {await cleanup();}
});

test('stop cancels an in-flight behavior application; a late running ACK cannot overwrite stopped', async () => {
 const {runtime,cleanup}=await fixture();
 try {
  assert.equal((await runtime.start()).status,'running');
  const apply=runtime.applyBehaviorPreferences({scheduledActivity:true,movement:false});
  const stop=runtime.stop();
  assert.equal(await apply,false);
  assert.equal((await stop).status,'stopped');
  assert.equal(runtime.snapshot().status,'stopped');assert.equal(runtime.pid,undefined);
 } finally {await cleanup();}
});
