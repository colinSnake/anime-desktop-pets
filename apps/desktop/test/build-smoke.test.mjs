/** 对实际生产构建做独立 Node 冒烟；不启动 Electron/Qt。 */
import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { readFile, readdir, access, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";

const out = resolve("apps/desktop/dist");
test("build emits sandbox preload, relative local assets and an isolated diagnostic worker", async () => {
  const html = await readFile(`${out}/ui/index.html`, "utf8");
  assert.match(html, /lang="zh-CN"/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /src="\.\/assets\//);
  assert.doesNotMatch(html, /https?:\/\//);
  const assets = await readdir(`${out}/ui/assets`);
  assert.ok(assets.some((file) => file.endsWith(".js")));
  assert.ok(assets.some((file) => file.endsWith(".css")));
  assert.equal(await readFile(`${out}/runtime/pet_cover.py`, "utf8"),
    await readFile("apps/runtime-bridge/pet_cover.py", "utf8"));
  for (const name of ['pet_sources.py', 'pet_library.py', 'pet_reference_lock.py']) {
    assert.equal(await readFile(`${out}/runtime/${name}`, 'utf8'), await readFile(`apps/pet-runtime/pets/${name}`, 'utf8'));
  }
  const preload = await readFile(`${out}/preload.cjs`, "utf8");
  assert.match(preload, /exposeInMainWorld/);
  assert.doesNotMatch(preload, /node:fs|node:child_process|Bearer|token/);
  assert.equal(
    await readFile(`${out}/runtime/worker.py`, "utf8"),
    await readFile("apps/runtime-bridge/worker.py", "utf8"),
  );
  assert.equal(
    await readFile(`${out}/runtime/guardian.py`, "utf8"),
    await readFile("apps/runtime-bridge/guardian.py", "utf8"),
  );
});
test("desktop uses the service workspace export rather than a stale colocated bundle", async () => {
  const entry = createRequire(resolve("apps/desktop/package.json")).resolve("@pet/app-service");
  assert.equal(entry, resolve("apps/app-service/dist/entry.cjs"));
  assert.equal(
    await realpath(createRequire(entry).resolve("fastify/package.json")),
    await realpath(resolve("apps/app-service/node_modules/fastify/package.json")),
  );
  const main = await readFile(`${out}/main.cjs`, "utf8");
  assert.match(main, /resolve\("@pet\/app-service"\)/);
  assert.doesNotMatch(main, /service\.cjs/);
  await assert.rejects(access(`${out}/service.cjs`), { code: "ENOENT" });
});
test("compiled service authenticates, probes its copied worker and shuts down", async () => {
  const child = fork(createRequire(resolve("apps/desktop/package.json")).resolve("@pet/app-service"), [], {
    execArgv: [],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const exit = new Promise((resolveExit) =>
    child.once("exit", (code, signal) => resolveExit({ code, signal })),
  );
  const token = randomBytes(32).toString("hex");
  try {
    const ready = new Promise((resolveReady, reject) => {
      const timer = setTimeout(
        () => reject(new Error("compiled_service_startup_timeout")),
        5000,
      );
      child.once("message", (message) => {
        clearTimeout(timer);
        resolveReady(message);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("compiled_service_exited"));
      });
    });
    child.send({
      type: "bootstrap",
      version: 1,
      token,
      workerPath: `${out}/runtime/worker.py`,
      guardianPath: `${out}/runtime/guardian.py`,
      python: process.env.PET_PYTHON,
    });
    const message = await ready;
    assert.equal(message.type, "ready");
    const base = `http://127.0.0.1:${message.port}`;
    assert.equal((await fetch(`${base}/v1/snapshot`)).status, 401);
    const response = await fetch(`${base}/v1/runtime/probe`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.runtime.status, "ready");
    assert.equal(value.platform.desktopPet, "not-integrated");
    child.send({ type: "shutdown" });
    const result = await Promise.race([
      exit,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("compiled_service_shutdown_timeout")),
          4000,
        );
        timer.unref();
      }),
    ]);
    assert.equal(result.code, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exit;
  }
});

test("build copies every private player module and exposes only fixed no-arg actions", async () => {
  for (const name of ['player_worker.py', 'player_protocol.py', 'player_adapter.py']) {
    assert.equal(await readFile(`${out}/runtime/${name}`, 'utf8'), await readFile(`apps/runtime-bridge/${name}`, 'utf8'));
  }
  const preload = await readFile(`${out}/preload.cjs`, 'utf8');
  assert.match(preload, /startPlayer: \(\) => .*invoke\("pet:start-player"\)/);
  assert.match(preload, /stopPlayer: \(\) => .*invoke\("pet:stop-player"\)/);
  assert.match(preload, /importPackages: \(\) => .*invoke\(['"]pet:pets-importPackages['"]\)/);
  assert.doesNotMatch(preload, /importPackages: \([^)]/);
});

test('compiled pet workspace persists isolated metadata and preload has only fixed typed pet methods', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pet-compiled-workspace-'));
  const child = fork(createRequire(resolve('apps/desktop/package.json')).resolve('@pet/app-service'), [], {execArgv:[],stdio:['ignore','ignore','ignore','ipc']});
  const exit = new Promise(r => child.once('exit', code => r(code)));
  try {
    const ready = new Promise((r, reject) => { const timer=setTimeout(()=>reject(new Error('startup_timeout')),5000); child.once('message', value=>{clearTimeout(timer);r(value);}); child.once('exit',()=>{clearTimeout(timer);reject(new Error('early_exit'));}); });
    const token = randomBytes(32).toString('hex');
    child.send({type:'bootstrap',version:1,token,workerPath:`${out}/runtime/worker.py`,guardianPath:`${out}/runtime/guardian.py`,workspace:{root,catalog:[{id:'local.pet',version:'1.0.0',name:'合成桌宠'}]}});
    const value = await ready;
    const url=`http://127.0.0.1:${value.port}/v1/pets`;
    const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
    assert.equal((await fetch(url)).status,401);
    const added = await fetch(`${url}/add`,{method:'POST',headers,body:JSON.stringify({expectedRevision:0,package:{id:'local.pet',version:'1.0.0'}})});
    assert.equal(added.status,200); assert.equal((await added.json()).workspace.instances[0].phase,'not-connected');
    const disk = JSON.parse(await readFile(join(root,'workspace-state.json'),'utf8'));
    assert.equal(disk.registry.instances.length,1); assert.equal(disk.revision,1);
    const preload = await readFile(`${out}/preload.cjs`,'utf8');
    for (const method of ['list','add','clone','delete','save','theme','start','stop','applyBehavior']) assert.ok(preload.includes(`pet:pets-${method}`));
    assert.doesNotMatch(preload,/node:fs|node:child_process|Bearer|token/);
    child.send({type:'shutdown'});
    assert.equal(await Promise.race([exit,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('shutdown_timeout')),5000);timer.unref();})]),0);
  } finally { if(child.exitCode===null && child.signalCode===null) child.kill('SIGKILL'); await exit; await rm(root,{recursive:true,force:true}); }
});

test('compiled instance lifecycle owns isolated synthetic workers and retains the three-slot boundary', async () => {
  const { mkdtemp, rm, copyFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pet-compiled-lifecycle-'));
  const worker = join(root, 'behavior.py');
  await copyFile(resolve('apps/app-service/test/fixtures/player-fixture.py'), worker);
  const child = fork(createRequire(resolve('apps/desktop/package.json')).resolve('@pet/app-service'), [], {execArgv:[],stdio:['ignore','ignore','ignore','ipc']});
  const exit = new Promise(r => child.once('exit', code => r(code)));
  try {
    const ready = new Promise((r,reject) => {
      const timer=setTimeout(()=>reject(Error('startup_timeout')),5000);
      child.once('message',value=>{clearTimeout(timer);r(value);});
      child.once('exit',()=>{clearTimeout(timer);reject(Error('early_exit'));});
    });
    const token=randomBytes(32).toString('hex');
    const pkg={id:'local.development.longmei',version:'0.0.0-dev'};
    child.send({type:'bootstrap',version:1,token,workerPath:`${out}/runtime/worker.py`,guardianPath:`${out}/runtime/guardian.py`,python:process.env.PET_PYTHON,
      player:{workerPath:worker,config:{source:root,assets:root,profileRoot:join(root,'sessions')}},
      workspace:{root:join(root,'workspace'),catalog:[{...pkg,name:'合成开发角色'}]}});
    const message=await ready;assert.equal(message.type,'ready');
    const base=`http://127.0.0.1:${message.port}/v1/pets`;
    const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
    const request=async(action,input)=>{
      const response=await fetch(`${base}${action?`/${action}`:''}`,{method:action?'POST':'GET',headers,...(action?{body:JSON.stringify(input)}:{}),signal:AbortSignal.timeout(5000)});
      return {status:response.status,value:await response.json()};
    };
    const ids=[];
    for(let revision=0;revision<4;revision++) {
      const added=await request('add',{expectedRevision:revision,package:pkg});assert.equal(added.status,200);
      ids.push(added.value.workspace.instances[revision].id);
    }
    const disk=await readFile(join(root,'workspace','workspace-state.json'));
    const start=id=>request('start',{expectedRevision:4,id});
    // Other OSes exercise the actual entry-point's rejection, never pretend Qt is portable.
    if(process.platform!=='darwin') {
      const blocked=await start(ids[0]);assert.equal(blocked.status,409);assert.equal(blocked.value.error,'package-unavailable');
      assert.equal((await request('')).value.workspace.instances[0].phase,'not-connected');
    } else {
      for(const id of ids.slice(0,3)) assert.equal((await start(id)).status,200);
      const full=await start(ids[3]);assert.equal(full.status,409);assert.equal(full.value.error,'limit');
      const waitPhase=async(id,wanted)=>{
        const deadline=Date.now()+7000;
        while(Date.now()<deadline) {
          const result=await request('');
          if(result.value.workspace.instances.find(p=>p.id===id).phase===wanted)return;
          await new Promise(r=>setTimeout(r,20));
        }
        throw Error(`synthetic_phase_timeout:${wanted}`);
      };
      await Promise.all(ids.slice(0,3).map(id=>waitPhase(id,'running')));
      const applied=await request('apply-behavior',{expectedRevision:4,id:ids[0]});
      assert.equal(applied.status,200);assert.equal(applied.value.workspace.revision,4);
      assert.deepEqual(applied.value.workspace.instances[0].behavior,{status:'applied',scheduledActivity:true,movement:true});
      const pids=[];
      for(const id of ids.slice(0,3)) {
        const sessions=await readdir(join(root,'sessions','instances',id));assert.equal(sessions.length,1);
        const preferences=JSON.parse(await readFile(join(root,'sessions','instances',id,sessions[0],'bootstrap-preferences.json'),'utf8'));
        assert.deepEqual(preferences,{size:256,hideInFullscreen:true,scheduledActivity:true,movement:true});
        pids.push(Number(await readFile(join(root,'sessions','instances',id,sessions[0],'worker.pid'),'utf8')));
      }
      assert.equal(new Set(pids).size,3);
      const active=await request('delete',{expectedRevision:4,id:ids[0]});assert.equal(active.value.error,'active');
      assert.equal((await request('stop',{expectedRevision:4,id:ids[0]})).status,200);
      await waitPhase(ids[0],'stopped');assert.throws(()=>process.kill(pids[0],0));
      assert.equal((await start(ids[3])).status,200);await waitPhase(ids[3],'running');
      const listing=(await request('')).value;assert.doesNotMatch(JSON.stringify(listing),/worker\.pid|profileRoot|Bearer|\/sessions\//);
    }
    assert.deepEqual(await readFile(join(root,'workspace','workspace-state.json')),disk);
    const preload=await readFile(`${out}/preload.cjs`,'utf8');
    for(const action of ['start','stop'])assert.ok(preload.includes(`pet:pets-${action}`));
    child.send({type:'shutdown'});
    assert.equal(await Promise.race([exit,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('shutdown_timeout')),9000);timer.unref();})]),0);
    // Successful shutdown confirms all owned worker processes and writer lease are gone.
    await assert.rejects(access(join(root,'workspace','.workspace-writer.lock')),{code:'ENOENT'});
    if(process.platform==='darwin')for(const id of ids) {
      const sessions=await readdir(join(root,'sessions','instances',id));
      for(const session of sessions) {
        const pid=Number(await readFile(join(root,'sessions','instances',id,session,'worker.pid'),'utf8'));
        assert.throws(()=>process.kill(pid,0));
      }
    }
  } finally {
    if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');
    await exit;await rm(root,{recursive:true,force:true});
  }
});
