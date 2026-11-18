/** 对实际生产构建做独立 Node 冒烟；不启动 Electron/Qt。 */
import assert from "node:assert/strict";
import test from "node:test";
import { fork, spawnSync } from "node:child_process";
import { readFile, readdir, access, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";

const out = resolve("apps/desktop/dist");
test("status bar template icons ship with both scale factors and remain outside preload", async () => {
  for (const [file, size] of [["petStatusTemplate.png", 16], ["petStatusTemplate@2x.png", 32]]) {
    const asset = await readFile(`${out}/branding/${file}`);
    assert.deepEqual(asset, await readFile(`resources/branding/${file}`));
    assert.equal(asset.subarray(1, 4).toString(), "PNG");
    assert.equal(asset.readUInt32BE(16), size);
    assert.equal(asset.readUInt32BE(20), size);
  }
  assert.doesNotMatch(await readFile(`${out}/preload.cjs`, "utf8"), /petStatusTemplate|打开管理工作区|刷新本机状态/);
});
test('workspace and developer Dock ship the original product icon without a preload bridge', async () => {
  for (const [output, source] of [["ui/assets/app-icon.svg", "app-icon.svg"], ["branding/app-icon.png", "app-icon.png"]]) {
    assert.deepEqual(await readFile(`${out}/${output}`), await readFile(`resources/branding/${source}`));
  }
  assert.doesNotMatch(await readFile(`${out}/preload.cjs`, 'utf8'), /app-icon\.(svg|png)/);
});
test('Codex presence probe is packaged for trusted macOS code and rejects arguments', async () => {
  const helper = resolve(out, 'codex-presence');
  const main = await readFile(resolve(out, 'main.cjs'), 'utf8');
  assert.match(main, /codex-presence/);
  const menuLabel = /(?:开始观察|\\u5f00\\u59cb\\u89c2\\u5bdf) Codex/i;
  assert.match(main, menuLabel);
  const preload = await readFile(resolve(out, 'preload.cjs'), 'utf8');
  assert.doesNotMatch(preload, /codex-presence/);
  assert.doesNotMatch(preload, menuLabel);
  if (process.platform !== 'darwin') {
    await assert.rejects(access(helper), { code: 'ENOENT' });
    return;
  }
  // The extra argument takes the guard branch before any real AppKit lookup.
  const rejected = spawnSync(helper, ['--synthetic-invalid'], { env: { LC_ALL: 'C' }, timeout: 1500, maxBuffer: 64, killSignal: 'SIGKILL' });
  assert.ifError(rejected.error);
  assert.equal(rejected.status, 64);
  assert.equal(rejected.stdout.length, 0);
  assert.equal(rejected.stderr.length, 0);
});
test('task reading stages the unchanged lifecycle parser only on macOS and stays outside preload', async () => {
  const files = { 'dragon_tasks.py': 'apps/pet-runtime/bailong/dragon_tasks.py',
    'task_reader.py': 'apps/runtime-bridge/task_reader.py', 'task_reader_worker.py': 'apps/runtime-bridge/task_reader_worker.py' };
  assert.doesNotMatch(await readFile(resolve(out, 'preload.cjs'), 'utf8'), /codex-task-following|task_reader|taskFollowingHome/);
  assert.match(await readFile(resolve(out, 'main.cjs'), 'utf8'), /codex-task-following/);
  for (const [name, source] of Object.entries(files)) {
    const path = resolve(out, 'runtime', name);
    if (process.platform === 'darwin') assert.deepEqual(await readFile(path), await readFile(source));
    else await assert.rejects(access(path), { code: 'ENOENT' });
  }
});
test('startup geometry helper is packaged for macOS main only and rejects probe arguments', async () => {
  const helper = resolve(out, 'codex-window-bounds');
  assert.match(await readFile(resolve(out, 'main.cjs'), 'utf8'), /codex-window-bounds/);
  assert.doesNotMatch(await readFile(resolve(out, 'preload.cjs'), 'utf8'), /codex-window-bounds/);
  if (process.platform !== 'darwin') {
    await assert.rejects(access(helper), { code: 'ENOENT' });
    return;
  }
  // Reject before a live AppKit or Quartz lookup.
  const rejected = spawnSync(helper, ['--synthetic-invalid'], { env: { LC_ALL: 'C' }, timeout: 1500, maxBuffer: 64, killSignal: 'SIGKILL' });
  assert.ifError(rejected.error);
  assert.equal(rejected.status, 64);
  assert.equal(rejected.stdout.length, 0);
  assert.equal(rejected.stderr.length, 0);
});
test('the fixed startup mode is macOS scoped and its isolated player signals play and skip without IPC', async () => {
  const { runInNewContext } = await import('node:vm');
  const startup = resolve(out, 'startup');
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.doesNotMatch(pkg.scripts['dev:desktop'], /--launch-codex/);
  assert.match(pkg.scripts['dev:desktop:codex'], /--launch-codex$/);
  assert.doesNotMatch(await readFile(resolve(out, 'preload.cjs'), 'utf8'), /pet-startup|--launch-codex|\/usr\/bin\/open/);
  if (process.platform !== 'darwin') {
    await assert.rejects(access(startup), { code: 'ENOENT' });
    return;
  }
  const html = await readFile(resolve(startup, 'index.html'), 'utf8');
  assert.match(html, /src="startup.mp4"/);
  assert.doesNotMatch(html, /https?:|file:|\bmuted\b/);
  assert.match(await readFile(resolve(out, 'main.cjs'), 'utf8'), /pet-startup/);
  const events = new Map();
  const window = { location: { hash: '' }, addEventListener: () => {} };
  let paused = 0, plays = 0;
  const movie = { addEventListener(name, fn) { events.set(name, fn); },
    play: async () => { plays++; }, pause() { paused++; } };
  const button = { addEventListener(name, fn) { events.set(name, fn); } };
  const document = { querySelector: key => key === '#movie' ? movie : button };
  await runInNewContext(await readFile(resolve(startup, 'player.js'), 'utf8'), { window, document });
  assert.equal(plays, 1);
  events.get('playing')(); assert.equal(window.location.hash, 'playing');
  events.get('click')(); assert.equal(window.location.hash, 'skipped');
  events.get('ended')(); assert.equal(window.location.hash, 'skipped');
  assert.equal(paused, 1);
});
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

test('compiled model management is macOS scoped, authenticated and persists only in its synthetic profile', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { once } = await import('node:events');
  const base = await mkdtemp(join(await realpath(tmpdir()), 'pet-compiled-models-'));
  const modelsRoot = join(base, 'models');
  const entry = createRequire(resolve('apps/desktop/package.json')).resolve('@pet/app-service');
  const child = fork(entry, [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exit = once(child, 'exit');
  try {
    const signal = AbortSignal.timeout(5000), ready = once(child, 'message', { signal });
    const token = randomBytes(32).toString('hex');
    child.send({ type:'bootstrap', version:1, token, modelsRoot,
      workerPath:`${out}/runtime/worker.py`, guardianPath:`${out}/runtime/guardian.py` });
    const [message] = await ready; assert.equal(message.type,'ready');
    const url = `http://127.0.0.1:${message.port}/v1/models`;
    const headers = {authorization:`Bearer ${token}`, 'content-type':'application/json'};
    assert.equal((await fetch(url,{ signal })).status,401);
    const listing = await fetch(url,{ headers, signal });
    if (process.platform === 'darwin') {
      assert.equal(listing.status,200); assert.equal((await listing.json()).configuration.revision,0);
      const connection = {id:'fake',displayName:'合成连接',preset:'custom',apiProtocol:'chat-completions',baseURL:'https://synthetic.invalid/v1',authMode:'apiKey', compatibility:{},defaultModelEntryID:'entry',models:[{entryID:'entry',modelID:'fake',displayName:'合成模型',capabilities:{tools:{status:'unknown',source:'user'}},compatibility:{}}]};
      const saved = await fetch(url+'/save',{method:'POST',headers,signal,body:JSON.stringify({connection,expectedRevision:0,credential:{kind:'keep'}})});
      assert.equal(saved.status,200); assert.equal((await saved.json()).configuration.connections[0].credentialState,'missing');
      const disk = JSON.parse(await readFile(join(modelsRoot,'model-providers.json'),'utf8'));
      assert.equal(disk.revision,1); assert.ok(!Object.hasOwn(disk.connections[0],'credentialRef'));
      assert.equal((await fetch(url+'/complete',{method:'POST',headers,body:'{}',signal})).status,404);
    } else {
      assert.equal(listing.status,404); await assert.rejects(access(modelsRoot),{code:'ENOENT'});
      await assert.rejects(access(join(resolve(entry,'..'),'model-keychain')),{code:'ENOENT'});
    }
    assert.doesNotMatch(await readFile(`${out}/preload.cjs`,'utf8'),/\/v1\/models|model-keychain|clipboard|mcred-v1/);
    child.send({type:'shutdown'});
    assert.equal((await once(child,'exit',{signal}))[0],0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exit; await rm(base,{recursive:true,force:true});
  }
});

test('native model helper is packaged and rejects malformed stdin before any Keychain operation', { skip: process.platform !== 'darwin' }, async () => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const entry = createRequire(resolve('apps/desktop/package.json')).resolve('@pet/app-service');
  const runner = spawn(resolve(entry,'..','model-keychain'), [], { stdio: ['pipe','pipe','ignore'], env: { LC_ALL:'C' }, timeout:3000, killSignal:'SIGKILL' });
  const output = [];
  runner.stdout.on('data',chunk => output.push(chunk));
  runner.stdin.end(JSON.stringify({version:888,operation:'invalid',account:'not-a-reference'}));
  assert.equal((await once(runner,'close'))[0],0);
  assert.deepEqual(JSON.parse(Buffer.concat(output).toString('utf8')),{version:1,status:'unavailable'});
});


test('compiled sandbox preload exposes only fixed model management, discovery and connection test actions on macOS only', async () => {
  const { runInNewContext } = await import('node:vm');
  const preload = await readFile(`${out}/preload.cjs`, 'utf8');
  for (const platform of ['darwin', 'win32', 'linux']) {
    let bridge;
    const calls = [];
    runInNewContext(preload, { process: { platform }, require: name => {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } }, ipcRenderer: {
        invoke(...args) { calls.push(args); return Promise.resolve({ ok: false }); },
      } };
    } });
    if (platform !== 'darwin') { assert.equal(bridge.models, undefined); continue; }
    const channels = { list: 'list', save: 'save', setDefault: 'default', remove: 'remove', prepareKeySave: 'prepare-key-save', cancelKeySave: 'cancel-key-save', discover: 'discover', cancelDiscovery: 'cancel-discovery', testConnection: 'test-connection', cancelConnectionTest: 'cancel-connection-test' };
    assert.deepEqual(Object.keys(bridge.models), Object.keys(channels));
    for (const [method, channel] of Object.entries(channels)) {
      const args = method === 'list' || method === 'cancelKeySave' ? [] : method === 'cancelDiscovery' || method === 'cancelConnectionTest' ? ['synthetic-operation'] : [{ synthetic: true }];
      await bridge.models[method](...args);
      assert.deepEqual(calls.pop(), [`pet:models-${channel}`, ...args]);
    }
  }
});


test('compiled speech bridge only exposes reference and session controls on Apple silicon macOS', async () => {
  const { runInNewContext } = await import('node:vm');
  const preload = await readFile(`${out}/preload.cjs`, 'utf8');
  assert.equal(await readFile(`${out}/runtime/speech/bubble_speech_worker.py`, 'utf8'), await readFile('apps/runtime-bridge/bubble_speech_worker.py', 'utf8'));
  assert.equal(await readFile(`${out}/runtime/speech/stdio_service.py`, 'utf8'), await readFile('apps/speech-runtime/stdio_service.py', 'utf8'));
  for (const [platform, arch] of [['darwin','arm64'], ['darwin','x64'], ['linux','arm64'], ['win32','x64']]) {
    let bridge;
    const calls = [];
    runInNewContext(preload, { process: { platform, arch }, require: () => ({
      contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { invoke(...args) { calls.push(args); return Promise.resolve({ ok: false }); } },
    }) });
    if (platform !== 'darwin' || arch !== 'arm64') { assert.equal(bridge.speech, undefined); continue; }
    const methods = ['status', 'selectReference', 'clearReference', 'enable', 'disable'];
    assert.deepEqual(Object.keys(bridge.speech), methods);
    for (const method of methods) {
      const args = method === 'enable' ? [{ referenceTranscript: '合成文本' }] : [];
      await bridge.speech[method](...args);
      assert.deepEqual(calls.pop(), [`pet:speech-${method}`, ...args]);
    }
  }
});

test('compiled character bridge exposes only fixed identity, context, memory and goal actions on macOS', async () => {
  const { runInNewContext } = await import('node:vm');
  const preload = await readFile(`${out}/preload.cjs`, 'utf8');
  for (const platform of ['darwin', 'linux', 'win32']) {
    let bridge;
    const calls = [];
    runInNewContext(preload, { process: { platform }, require: () => ({
      contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { invoke(...args) { calls.push(args); return Promise.resolve({ ok: false }); } },
    }) });
    if (platform !== 'darwin') { assert.equal(bridge.characters, undefined); continue; }
    assert.deepEqual(Object.keys(bridge.characters), ['readIdentity', 'saveIdentity', 'restoreIdentity', 'setIdentityChatShare', 'localChatContext', 'searchKnowledge', 'readMemories', 'readMemoryHistory', 'editMemory', 'restoreMemory', 'selectKnowledgeFile', 'addKnowledgeBatch', 'addMemory', 'confirmMemory', 'withdrawMemory', 'deleteMemory', 'setMemoryChatShare', 'readGoals', 'addGoal', 'editGoal', 'deleteGoal', 'setGoalChatShare']);
    const input = { petID: 'pet-synthetic' };
    for (const action of ['readIdentity', 'saveIdentity', 'restoreIdentity', 'setIdentityChatShare', 'localChatContext', 'searchKnowledge', 'readMemories', 'readMemoryHistory', 'editMemory', 'restoreMemory', 'addKnowledgeBatch', 'addMemory', 'confirmMemory', 'withdrawMemory', 'deleteMemory', 'setMemoryChatShare', 'readGoals', 'addGoal', 'editGoal', 'deleteGoal', 'setGoalChatShare']) {
      await bridge.characters[action](input);
      assert.deepEqual(calls.pop(), [`pet:characters-${action}`, input]);
    }
    await bridge.characters.selectKnowledgeFile({ path: '/synthetic/renderer-argument.txt' });
    assert.deepEqual(calls.pop(), ['pet:characters-selectKnowledgeFile']);
  }
});

test('compiled preload exposes only fixed online chat methods on macOS', async () => {
  const { runInNewContext } = await import('node:vm');
  const preload = await readFile(`${out}/preload.cjs`, 'utf8');
  for (const platform of ['darwin', 'win32', 'linux']) {
    let bridge; const calls = [];
    runInNewContext(preload, { process: { platform }, require: () => ({
      contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { invoke: async (...args) => calls.push(args) },
    }) });
    if (platform !== 'darwin') { assert.equal(bridge.onlineChat, undefined); continue; }
    assert.deepEqual(Object.keys(bridge.onlineChat), ['list', 'send', 'cancel']);
    await bridge.onlineChat.list('ignored'); await bridge.onlineChat.send({}); await bridge.onlineChat.cancel('synthetic');
    assert.deepEqual(calls, [['pet:chat-models'], ['pet:chat-send', {}], ['pet:chat-cancel', 'synthetic']]);
  }
  assert.doesNotMatch(preload, /\/v1\/chat|127\.0\.0\.1|mcred-v1/);
});
