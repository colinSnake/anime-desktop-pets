/** 对实际生产构建做独立 Node 冒烟；不启动 Electron/Qt。 */
import assert from "node:assert/strict";
import test from "node:test";
import { fork, spawnSync } from "node:child_process";
import { readFile, readdir, access, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";

const out = resolve("apps/desktop/dist");
test('built stage ships fixed scene layers and workspace previews without character media or a renderer bridge', async () => {
  const files = ['index.html', 'stage.css', 'stage.js'];
  for (const id of ['desk-room', 'rain-loft', 'cloud-terrace', 'meadow', 'forest', 'studio']) {
    for (const layer of ['room', 'desk', 'cover', 'preview']) files.push(`${id}-${layer}.webp`);
  }
  assert.deepEqual((await readdir(`${out}/live-stage`)).sort(), files.sort());
  assert.match(await readFile(`${out}/live-stage/index.html`, 'utf8'), /<title>龙妹的直播舞台<\/title>[\s\S]*<video id="idle" muted loop/);
  const script = await readFile(`${out}/live-stage/stage.js`, 'utf8');
  assert.match(script, /requestVideoFrameCallback/);
  assert.doesNotMatch(script, /petDesktop|ipcRenderer|require\(|https?:\/\//);
  for (const path of files.filter(file => file.endsWith('.webp'))) {
    const bytes = await readFile(`${out}/live-stage/${path}`);
    assert.equal(bytes.subarray(8, 12).toString(), 'WEBP');
    if (path.endsWith('-preview.webp')) assert.deepEqual(bytes, await readFile(`apps/desktop/src/live-stage/art/${path}`));
  }
});

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
  const files = { 'task_events.py': 'apps/runtime-bridge/task_events.py',
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
  assert.match(html.replaceAll('&#39;', "'"), /connect-src 'none'/);
  assert.match(html, /src="\.\/assets\//);
  assert.doesNotMatch(html, /https?:\/\//);
  const assets = await readdir(`${out}/ui/assets`);
  assert.ok(assets.some((file) => file.endsWith(".js")));
  assert.ok(assets.some((file) => file.endsWith(".css")));
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

test("build excludes Qt modules and keeps the fixed material picker", async () => {
  for (const name of ['player_worker.py', 'player_protocol.py', 'player_adapter.py', 'player_quota.py', 'pet_cover.py', 'qt_preflight.py', 'dragon_tasks.py']) {
    await assert.rejects(access(`${out}/runtime/${name}`), { code: 'ENOENT' });
  }
  const preload = await readFile(`${out}/preload.cjs`, 'utf8');
  assert.doesNotMatch(preload, /startPlayer|stopPlayer|pet:(?:start|stop)-player/);
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

test('compiled startup launches one default owned window and retains the three-slot boundary', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pet-compiled-lifecycle-'));
  const child = fork(createRequire(resolve('apps/desktop/package.json')).resolve('@pet/app-service'), [], {execArgv:[],stdio:['ignore','ignore','ignore','ipc']});
  const exit = new Promise(r => child.once('exit', code => r(code)));
  const video = process.platform === 'darwin';
  const windows = new Map(), commands = [], problems = [];
  child.on('message', value => {
    if (value.type !== 'workspace-video-command') return;
    const { id, seq, epoch, op } = value;
    commands.push(value);
    let result;
    if (!video) problems.push('video requested on unsupported platform');
    if (op === 'start') {
      if (windows.has(id) || windows.size >= 3) problems.push('unowned or duplicate allocation');
      windows.set(id, seq);
      result = 'running';
    } else if (op === 'stop') {
      windows.delete(id);
      result = 'stopped';
    } else {
      if (!windows.has(id) || windows.get(id) !== epoch) problems.push('stale window command');
      if (op === 'task') return;
      result = 'applied';
    }
    child.send({ type: 'workspace-video-result', version: 1, id, seq, result });
  });
  try {
    const ready = new Promise((r,reject) => {
      const timer=setTimeout(()=>reject(Error('startup_timeout')),5000);
      child.once('message',value=>{clearTimeout(timer);r(value);});
      child.once('exit',()=>{clearTimeout(timer);reject(Error('early_exit'));});
    });
    const token=randomBytes(32).toString('hex');
    const pkg={id:'local.development.longmei',version:'0.0.0-dev'};
    child.send({type:'bootstrap',version:1,token,workerPath:`${out}/runtime/worker.py`,guardianPath:`${out}/runtime/guardian.py`,python:process.env.PET_PYTHON,
      ...(video ? { workspaceVideo: true } : {}),
      workspace:{root:join(root,'workspace'),catalog:[{...pkg,name:'合成开发角色',launchable:video}]}});
    const message=await ready;assert.equal(message.type,'ready');
    const base=`http://127.0.0.1:${message.port}/v1/pets`;
    const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
    const request=async(action,input)=>{
      const response=await fetch(`${base}${action?`/${action}`:''}`,{method:action?'POST':'GET',headers,...(action?{body:JSON.stringify(input)}:{}),signal:AbortSignal.timeout(5000)});
      return {status:response.status,value:await response.json()};
    };
    const initial=await request('');
    assert.equal(initial.status,200);
    assert.equal(initial.value.workspace.revision,video?1:0);
    assert.equal(initial.value.workspace.instances.length,video?1:0);
    if(video) assert.equal(initial.value.workspace.instances[0].autoStartOnLaunch,true);
    const ids=initial.value.workspace.instances.map(pet=>pet.id);
    for(let revision=ids.length;revision<4;revision++) {
      const added=await request('add',{expectedRevision:revision,package:pkg});assert.equal(added.status,200);
      ids.push(added.value.workspace.instances[revision].id);
    }
    const disk=await readFile(join(root,'workspace','workspace-state.json'));
    const start=id=>request('start',{expectedRevision:4,id});
    // Without a macOS window host the instance remains non-launchable.
    if(!video) {
      const blocked=await start(ids[0]);assert.equal(blocked.status,409);assert.equal(blocked.value.error,'package-unavailable');
      assert.equal((await request('')).value.workspace.instances[0].phase,'not-connected');
    } else {
      for(const id of ids.slice(1,3)) assert.equal((await start(id)).status,200);
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
      assert.deepEqual([...windows.keys()], ids.slice(0,3));
      for (const command of commands.filter(value => value.op === 'start')) {
        assert.deepEqual(command.preferences, {size:256,hideInFullscreen:true,scheduledActivity:true,movement:true});
      }
      const active=await request('delete',{expectedRevision:4,id:ids[0]});assert.equal(active.value.error,'active');
      assert.equal((await request('stop',{expectedRevision:4,id:ids[0]})).status,200);
      await waitPhase(ids[0],'stopped');assert.equal(windows.has(ids[0]),false);
      assert.equal((await start(ids[3])).status,200);await waitPhase(ids[3],'running');
      const listing=(await request('')).value;assert.doesNotMatch(JSON.stringify(listing),/worker\.pid|profileRoot|Bearer|\/sessions\//);
    }
    assert.deepEqual(await readFile(join(root,'workspace','workspace-state.json')),disk);
    const preload=await readFile(`${out}/preload.cjs`,'utf8');
    for(const action of ['start','stop'])assert.ok(preload.includes(`pet:pets-${action}`));
    child.send({type:'shutdown'});
    assert.equal(await Promise.race([exit,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('shutdown_timeout')),9000);timer.unref();})]),0);
    await assert.rejects(access(join(root,'workspace','.workspace-writer.lock')),{code:'ENOENT'});
    assert.deepEqual([...windows.keys()], []);
    assert.deepEqual(problems, []);
    assert.equal(commands.filter(value => value.op === 'start').length, video ? 4 : 0);
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

test('compiled macOS service restores confirmed Responses probes across process restarts without retesting', { skip: process.platform !== 'darwin', timeout: 12_000 }, async t => {
  const { once } = await import('node:events');
  const { mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { createServer } = await import('node:http');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pet-compiled-probes-'));
  const modelsRoot = join(root, 'models'), workspace = join(root, 'workspace');
  let child, exited, fail = false;
  const requests = [];
  const provider = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ path: request.url, authenticated: request.headers.authorization !== undefined, body: JSON.parse(Buffer.concat(chunks)) });
    response.writeHead(fail ? 401 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(fail ? { error: 'PRIVATE-SYNTHETIC-FAILURE' } : {
      status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }],
    }));
  });
  t.after(async () => {
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(workspace, { mode: 0o700 });
  await writeFile(join(workspace, 'workspace-state.json'), JSON.stringify({ schemaVersion: 1, revision: 0, theme: 'system', registry: { schemaVersion: 1, instances: [] } }), { mode: 0o600 });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const boot = async () => {
    const token = randomBytes(32).toString('hex');
    child = fork(createRequire(resolve('apps/desktop/package.json')).resolve('@pet/app-service'), [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    exited = once(child, 'exit');
    const ready = once(child, 'message', { signal: AbortSignal.timeout(4000) });
    child.send({ type: 'bootstrap', version: 1, token, businessRoot: root, modelsRoot, workspace: { root: workspace, catalog: [] },
      workerPath: `${out}/runtime/worker.py`, guardianPath: `${out}/runtime/guardian.py` });
    const [message] = await ready;
    assert.equal(message.type, 'ready');
    return async (path = '', payload) => {
      const response = await fetch(`http://127.0.0.1:${message.port}/v1/models${path}`, {
        signal: AbortSignal.timeout(4000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(payload && { method: 'POST', body: JSON.stringify(payload) }),
      });
      return [response.status, await response.json()];
    };
  };
  const stop = async () => {
    child.send({ type: 'shutdown' });
    assert.deepEqual(await once(child, 'exit', { signal: AbortSignal.timeout(4000) }), [0, null]);
  };
  const connection = id => ({ id, displayName: id, preset: 'custom', apiProtocol: 'responses',
    baseURL: `http://127.0.0.1:${provider.address().port}/v1`, authMode: 'apiKey', compatibility: {}, defaultModelEntryID: 'entry',
    models: [{ entryID: 'entry', modelID: id, displayName: id, maxOutputTokens: 64, capabilities: { tools: { status: 'unknown', source: 'user' } }, compatibility: {} }],
  });
  let request = await boot();
  const evidence = [];
  for (const [id, expectedStatus] of [['synthetic-pass', 200], ['synthetic-fail', 502]]) {
    const [savedStatus, saved] = await request('/save', { connection: connection(id), expectedRevision: 0, credential: { kind: 'keep' } });
    assert.equal(savedStatus, 200);
    const revision = saved.configuration.connections.find(item => item.id === id).revision;
    const input = { connectionID: id, expectedRevision: revision, entryID: 'entry', modelID: id, maxOutputTokens: 64 };
    fail = expectedStatus !== 200;
    const [status, result] = await request('/test', input);
    assert.equal(status, expectedStatus, JSON.stringify(result));
    assert.deepEqual(result, fail ? { version: 1, ok: false, error: 'authentication_failed' } : { version: 1, ok: true, connectionID: id, revision, entryID: 'entry' });
    evidence.push({ input, result });
  }
  const receiptFile = join(modelsRoot, 'model-probes.json');
  const receipt = await readFile(receiptFile, 'utf8');
  assert.doesNotMatch(receipt, /PRIVATE-SYNTHETIC-FAILURE|credentialRef/);
  await stop();
  request = await boot();
  const [status, listing] = await request();
  assert.equal(status, 200);
  assert.deepEqual(listing.probeResults.map(({ testedAt, ...record }) => record), evidence);
  assert.deepEqual(requests.map(({ path, authenticated, body }) => [path, authenticated, body.model]), [
    ['/v1/responses', false, 'synthetic-pass'], ['/v1/responses', false, 'synthetic-fail'],
  ]);
  assert.equal(await readFile(receiptFile, 'utf8'), receipt);
  await stop();
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


test('compiled workspace data action uses a single fixed no-argument IPC method', async () => {
  const { runInNewContext } = await import('node:vm');
  let bridge;
  const calls = [];
  runInNewContext(await readFile(`${out}/preload.cjs`, 'utf8'), {
    process: { platform: process.platform }, require: name => {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
        ipcRenderer: { invoke(...args) { calls.push(args); return Promise.resolve('opened'); } } };
    },
  });
  assert.deepEqual(calls, []);
  assert.equal(await bridge.openWorkspaceData('/ignored', { command: 'ignored' }), 'opened');
  assert.deepEqual(calls, [['pet:open-workspace-data']]);
});

test('compiled legacy handoff exposes one macOS-only method and one scoped argument', async () => {
  const { runInNewContext } = await import('node:vm');
  const preload = await readFile(`${out}/preload.cjs`, 'utf8');
  for (const platform of ['darwin', 'win32', 'linux']) {
    let bridge;
    const calls = [];
    runInNewContext(preload, {
      process: { platform }, require: name => {
        assert.equal(name, 'electron');
        return { contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
          ipcRenderer: { invoke(...args) { calls.push(args); return Promise.resolve({ ok: false, error: 'cancelled' }); } } };
      },
    });
    assert.deepEqual(calls, []);
    if (platform !== 'darwin') assert.equal(bridge.legacyCharacterHandoff, undefined);
    else {
      assert.deepEqual(await bridge.legacyCharacterHandoff({ action: 'select', petID: 'development-1' }, '/forged/path'), { ok: false, error: 'cancelled' });
      assert.deepEqual(calls, [['pet:legacy-character-handoff', { action: 'select', petID: 'development-1' }]]);
    }
  }
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
    const channels = { list: 'list', save: 'save', setDefault: 'default', remove: 'remove', discover: 'discover', cancelDiscovery: 'cancel-discovery', testConnection: 'test-connection', cancelConnectionTest: 'cancel-connection-test' };
    assert.deepEqual(Object.keys(bridge.models), Object.keys(channels));
    for (const [method, channel] of Object.entries(channels)) {
      const args = method === 'list' ? [] : method === 'cancelDiscovery' || method === 'cancelConnectionTest' ? ['synthetic-operation'] : [{ synthetic: true }];
      await bridge.models[method](...args);
      assert.deepEqual(calls.pop(), [`pet:models-${channel}`, ...args]);
    }
  }
});


test('compiled speech and voice draft bridges expose fixed controls only on Apple silicon macOS', async () => {
  const { runInNewContext } = await import('node:vm');
  const preload = await readFile(`${out}/preload.cjs`, 'utf8');
  assert.equal(await readFile(`${out}/runtime/speech/bubble_speech_worker.py`, 'utf8'), await readFile('apps/runtime-bridge/bubble_speech_worker.py', 'utf8'));
  assert.equal(await readFile(`${out}/runtime/speech/stdio_service.py`, 'utf8'), await readFile('apps/speech-runtime/stdio_service.py', 'utf8'));
  assert.equal(await readFile(`${out}/runtime/speech/voice_draft_worker.py`, 'utf8'), await readFile('apps/speech-runtime/voice_draft_worker.py', 'utf8'));
  assert.equal(await readFile(`${out}/ui/assets/microphone-worklet.js`, 'utf8'), await readFile('apps/desktop/src/microphone-worklet.js', 'utf8'));
  for (const [platform, arch] of [['darwin','arm64'], ['darwin','x64'], ['linux','arm64'], ['win32','x64']]) {
    let bridge;
    const calls = [];
    const channels = [], listeners = new Map();
    class Button { constructor(action) { this.dataset = { microphoneAction: action }; } }
    runInNewContext(preload, { AbortController, HTMLButtonElement: Button,
      window: { addEventListener(type, listener, capture) { assert.equal(capture, true); listeners.set(type, listener); } }, process: { platform, arch, isMainFrame: true }, require: () => ({
      contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on(channel) { channels.push(channel); }, invoke(...args) { calls.push(args); return Promise.resolve({ ok: false }); } },
    }) });
    assert.equal(bridge.replySpeech, undefined, 'chat replies must not expose automatic speech controls');
    if (platform !== 'darwin' || arch !== 'arm64') { assert.equal(bridge.speech, undefined); assert.equal(bridge.voiceDraft, undefined); continue; }
    assert.deepEqual(Object.keys(bridge.voiceDraft), ['select', 'cancel', 'microphone']);
    assert.deepEqual(Object.keys(bridge.voiceDraft.microphone), ['authorize', 'start', 'stop', 'cancel']);
    assert.deepEqual(channels, ['pet:microphone-revoked']);
    const gesture = (action, type = 'click', overrides) => {
      const event = { type, isTrusted: true, eventPhase: 3, detail: 0, composedPath: () => [new Button(action)], ...overrides };
      listeners.get(type)(event);
      return event;
    };
    await bridge.voiceDraft.microphone.authorize({ isTrusted: true });
    gesture('start', 'click', { isTrusted: false });
    await bridge.voiceDraft.microphone.start({ isTrusted: true });
    const expired = gesture('start'); expired.eventPhase = 0;
    await bridge.voiceDraft.microphone.start(() => {});
    assert.deepEqual(calls, []);
    gesture('authorize');
    await bridge.voiceDraft.microphone.authorize({ path: '/not-forwarded' });
    await bridge.voiceDraft.microphone.authorize(); // consumed
    gesture('start', 'pointerdown', { isPrimary: true, button: 0 });
    await bridge.voiceDraft.microphone.start({ audio: 'not-forwarded' });
    await bridge.voiceDraft.microphone.stop({ audio: 'not-forwarded' });
    bridge.voiceDraft.microphone.cancel('not-forwarded');
    assert.deepEqual(calls.splice(0), [['pet:microphone-authorize'], ['pet:microphone-arm']]);
    await bridge.voiceDraft.select('/must-not-forward.wav'); await bridge.voiceDraft.cancel('/ignored');
    assert.deepEqual(calls.splice(0), [['pet:voice-draft-select'], ['pet:voice-draft-cancel']]);
    const methods = ['preview', 'stopPreview', 'status', 'selectReference', 'clearReference', 'saveTranscript', 'enable', 'disable'];
    assert.deepEqual(Object.keys(bridge.speech), methods);
    for (const method of methods) {
      const args = method === 'enable' || method === 'saveTranscript' ? [{ referenceTranscript: '合成文本' }] : [];
      await bridge.speech[method](...args, ...(method === 'enable' ? [] : [{ text: 'must not forward', revision: 999, play: true }]));
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
    assert.deepEqual(Object.keys(bridge.characters), ['readIdentity', 'saveIdentity', 'restoreIdentity', 'setIdentityChatShare', 'localChatContext', 'searchKnowledge', 'readMemories', 'readMemoryHistory', 'editMemory', 'restoreMemory', 'selectKnowledgeFile', 'addKnowledgeBatch', 'saveChatMemory', 'addMemory', 'confirmMemory', 'withdrawMemory', 'deleteMemory', 'setMemoryChatShare', 'readGoals', 'addGoal', 'editGoal', 'deleteGoal', 'setGoalChatShare']);
    const input = { petID: 'pet-synthetic' };
    for (const action of ['readIdentity', 'saveIdentity', 'restoreIdentity', 'setIdentityChatShare', 'localChatContext', 'searchKnowledge', 'readMemories', 'readMemoryHistory', 'editMemory', 'restoreMemory', 'addKnowledgeBatch', 'saveChatMemory', 'addMemory', 'confirmMemory', 'withdrawMemory', 'deleteMemory', 'setMemoryChatShare', 'readGoals', 'addGoal', 'editGoal', 'deleteGoal', 'setGoalChatShare']) {
      await bridge.characters[action](input);
      assert.deepEqual(calls.pop(), [`pet:characters-${action}`, input]);
    }
    await bridge.characters.selectKnowledgeFile({ path: '/synthetic/renderer-argument.txt' });
    assert.deepEqual(calls.pop(), ['pet:characters-selectKnowledgeFile']);
  }
});

test('compiled preload gives macOS only fixed data migration and instance history channels', async () => {
  const { runInNewContext } = await import('node:vm');
  const preload = await readFile(`${out}/preload.cjs`, 'utf8');
  for (const platform of ['darwin', 'win32', 'linux']) {
    let bridge; const calls = [];
    runInNewContext(preload, { process: { platform }, require: () => ({
      contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { invoke: async (...args) => calls.push(args) },
    }) });
    if (platform !== 'darwin') {
      assert.equal(bridge.migrateWorkspaceData, undefined); assert.equal(bridge.chatHistory, undefined); continue;
    }
    await bridge.migrateWorkspaceData({ root: '/not-accepted' });
    assert.deepEqual(Object.keys(bridge.chatHistory), ['list', 'detail', 'clear']);
    const input = { petID: 'pet-synthetic' }, detail = { ...input, id: '0f000000-0000-4000-8000-000000000001' }, clear = { ...input, confirmed: true };
    await bridge.chatHistory.list(input, '/not-accepted'); await bridge.chatHistory.detail(detail, '/not-accepted'); await bridge.chatHistory.clear(clear, '/not-accepted');
    assert.deepEqual(calls, [['pet:migrate-workspace-data'], ['pet:chat-history-list', input], ['pet:chat-history-detail', detail], ['pet:chat-history-clear', clear]]);
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
    assert.deepEqual(Object.keys(bridge.onlineChat), ['list', 'send', 'approveMaterials', 'cancel']);
    assert.deepEqual(Object.keys(bridge.chatProjects), ['list', 'create']);
    await bridge.onlineChat.list('ignored'); await bridge.onlineChat.send({}); await bridge.onlineChat.approveMaterials({}); await bridge.onlineChat.cancel('synthetic');
    await bridge.chatProjects.list({ petID: 'synthetic' }); await bridge.chatProjects.create({ petID: 'synthetic', name: '合成目录' });
    assert.deepEqual(calls, [['pet:chat-models'], ['pet:chat-send', {}], ['pet:chat-approve-materials', {}], ['pet:chat-cancel', 'synthetic'],
      ['pet:chat-project-list', { petID: 'synthetic' }], ['pet:chat-project-create', { petID: 'synthetic', name: '合成目录' }]]);
  }
  assert.doesNotMatch(preload, /\/v1\/chat|127\.0\.0\.1|mcred-v1/);
});

test('compiled macOS preload keeps legacy Agent records accessible without a task creation channel', async () => {
  const { runInNewContext } = await import('node:vm');
  const preload = await readFile(`${out}/preload.cjs`, 'utf8');
  const methods = ['list', 'read', 'cancel'];
  for (const platform of ['darwin', 'win32', 'linux']) {
    let bridge; const calls = [];
    runInNewContext(preload, { process: { platform }, require: () => ({
      contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { invoke: async (...args) => calls.push(args) },
    }) });
    if (platform !== 'darwin') { assert.equal(bridge.agentTasks, undefined); continue; }
    assert.deepEqual(Object.keys(bridge.agentTasks), methods);
    const input = { petID: 'pet-synthetic' };
    for (const method of methods) await bridge.agentTasks[method](input, 'pet:ignored');
    assert.deepEqual(calls, methods.map(method => [`pet:agent-tasks-${method}`, input]));
  }
  assert.doesNotMatch(preload, /\/v1\/agent-tasks|clipboard|agent-tasks\.sqlite|pet:agent-tasks-create/);
});

test('workspace video stages its fixed surface without media or workspace preload access', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const root = resolve(out, 'video');
  assert.match(pkg.scripts['dev:desktop'], /run-pet-video-preview\.mjs --workspace --hmr$/);
  assert.match(pkg.scripts['dev:desktop:static'], /run-pet-video-preview\.mjs --workspace$/);
  assert.match(pkg.scripts['dev:desktop:codex'], /run-pet-video-preview\.mjs --workspace --launch-codex$/);
  const main = await readFile(resolve(out, 'main.cjs'), 'utf8');
  assert.match(main, /PET_WORKSPACE_VIDEO_DIR/);
  assert.doesNotMatch(main, /PET_PLAYER_SOURCE|PET_PLAYER_ASSETS|player_worker\.py|PySide6/);
  assert.doesNotMatch(await readFile(resolve(out, 'preload.cjs'), 'utf8'), /pet-video|workspace-video|PET_WORKSPACE_VIDEO_DIR/);
  const probe = resolve(out, 'video-fullscreen');
  if (process.platform !== 'darwin') {
    await assert.rejects(access(root), { code: 'ENOENT' });
    await assert.rejects(access(probe), { code: 'ENOENT' });
    return;
  }
  const invalid = spawnSync(probe, ['--synthetic-invalid'], { env: { LC_ALL: 'C' }, timeout: 5000, maxBuffer: 16, killSignal: 'SIGKILL' });
  assert.ifError(invalid.error);
  assert.equal(invalid.status, 64);
  assert.equal(invalid.stdout.length + invalid.stderr.length, 0);
  assert.deepEqual((await readdir(root)).sort(), ['index.html', 'preload.cjs', 'quota_source.py', 'renderer.js', 'style.css']);
  assert.match(await readFile(resolve(root, 'preload.cjs'), 'utf8'), /exposeInMainWorld\("petVideoPreview"/);
});


test('the built service embeds Pi without shipping a DSH worker or provider bridge', async () => {
  const service = resolve('apps/app-service/dist');
  const retired = /dsh-sdk-client|harness-worker\.mjs|PET_HARNESS|pet-harness-node/;
  for (const name of ['main.cjs', 'preload.cjs']) assert.doesNotMatch(await readFile(resolve(out, name), 'utf8'), /@earendil-works|createPiTextRuntime|PET_HARNESS/);
  const entry = await readFile(resolve(service, 'entry.cjs'), 'utf8');
  assert.match(entry, /pi-agent-core.*agent-loop/);
  assert.match(entry, /chatRuntime: models && createPiTextRuntime/);
  assert.doesNotMatch(entry, retired);
  for (const name of ['pi-mit.txt', 'pi-schema-typebox.txt']) {
    assert.deepEqual(await readFile(resolve(service, 'licenses', name)), await readFile(resolve('licenses', name)));
  }
  await assert.rejects(access(resolve(service, 'harness-worker.mjs')), { code: 'ENOENT' });
});

test('compiled macOS service sends one Pi turn and persists only run metadata under an isolated business root', { skip: process.platform !== 'darwin', timeout: 10_000 }, async () => {
  const { mkdtemp, mkdir, rm, stat, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { once } = await import('node:events');
  const { createServer } = await import('node:http');
  const { randomUUID } = await import('node:crypto');
  const { DatabaseSync } = await import('node:sqlite');
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pet-compiled-agent-'));
  const workspace = join(root, 'workspace'), modelsRoot = join(root, 'models');
  const outbound = [];
  const provider = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    outbound.push({ path: request.url, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '我是合成伙伴。' } }] }));
  });
  let child, exit;
  try {
    await Promise.all([mkdir(workspace, { mode: 0o700 }), mkdir(modelsRoot, { mode: 0o700 }), writeFile(join(root, 'chats.sqlite'), '', { mode: 0o600 })]);
    await writeFile(join(workspace, 'workspace-state.json'), JSON.stringify({ schemaVersion: 1, revision: 0, theme: 'system', registry: { schemaVersion: 1, instances: [] } }), { mode: 0o600 });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const signal = AbortSignal.timeout(8000), token = randomBytes(32).toString('hex');
    child = fork(createRequire(resolve('apps/desktop/package.json')).resolve('@pet/app-service'), [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    exit = once(child, 'exit');
    const ready = once(child, 'message', { signal });
    const pkg = { id: 'local.pet', version: '1.0.0' };
    child.send({ type: 'bootstrap', version: 1, token, workerPath: `${out}/runtime/worker.py`, guardianPath: `${out}/runtime/guardian.py`,
      businessRoot: root, modelsRoot, workspace: { root: workspace, catalog: [{ ...pkg, name: '合成伙伴' }] } });
    const [message] = await ready;
    assert.equal(message.type, 'ready');
    const request = async (path, payload) => {
      const response = await fetch(`http://127.0.0.1:${message.port}${path}`, {
        signal, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(payload && { method: 'POST', body: JSON.stringify(payload) }),
      });
      return [response.status, await response.json()];
    };
    const [added, result] = await request('/v1/pets/add', { expectedRevision: 0, package: pkg });
    assert.equal(added, 200, JSON.stringify(result));
    const { id: petID } = result.workspace.instances[0];
    const connection = { id: 'synthetic', preset: 'custom', displayName: '合成连接', apiProtocol: 'chat-completions',
      baseURL: `http://127.0.0.1:${provider.address().port}/v1`, authMode: 'apiKey', compatibility: {}, defaultModelEntryID: 'entry',
      models: [{ entryID: 'entry', modelID: 'fake', displayName: '合成模型', capabilities: { tools: { status: 'unknown', source: 'user' } }, compatibility: {} }] };
    assert.equal((await request('/v1/models/save', { connection, expectedRevision: 0, credential: { kind: 'keep' } }))[0], 200);
    const [, listing] = await request('/v1/chat/models');
    const requestID = randomUUID(), conversation = { id: randomUUID(), mode: 'new' };
    const turn = { petID, requestID, route: listing.models[0].route, text: '你是谁？', history: [], conversation };
    const [status, reply] = await request('/v1/chat/send', turn);
    assert.equal(status, 200, JSON.stringify(reply));
    assert.deepEqual(reply, { ok: true, requestID, text: '我是合成伙伴。', replayable: true });
    assert.equal((await request('/v1/chat/send', turn))[0], 400);
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].path, '/v1/chat/completions');
    assert.equal(outbound[0].authorization, undefined);
    assert.deepEqual(outbound[0].body.messages, [{ role: 'user', content: '你是谁？' }]);
    child.send({ type: 'shutdown' });
    assert.deepEqual(await exit, [0, null]);
    const ledger = join(root, 'agent-state.sqlite');
    assert.equal((await stat(ledger)).mode & 0o777, 0o600);
    const db = new DatabaseSync(ledger, { readOnly: true });
    try { assert.deepEqual({ ...db.prepare('SELECT request_id, pet_id, source, status FROM runs').get() }, { request_id: requestID, pet_id: petID, source: 'chat', status: 'completed' }); }
    finally { db.close(); }
    assert.doesNotMatch((await readFile(ledger)).toString(), /你是谁|我是合成伙伴/);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'agents', petID, 'agent.json'), 'utf8')), { schemaVersion: 1, id: petID, runtime: 'pi', enabled: true, skills: [] });
  } finally {
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exit;
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('compiled Apple silicon speech service restores drafts and the explicit enable preference across restarts', { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 20_000 }, async () => {
  const { mkdtemp, mkdir, rm, stat, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { once } = await import('node:events');
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pet-compiled-speech-'));
  const workspace = join(root, 'workspace'), modelsRoot = join(root, 'models');
  const source = join(root, 'fixture.wav');
  const audio = Buffer.alloc(32044);
  audio.write('RIFF'); audio.writeUInt32LE(32036, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(32000, 40);
  let child, exit;
  async function start() {
    const token = randomBytes(32).toString('hex');
    child = fork(createRequire(resolve('apps/desktop/package.json')).resolve('@pet/app-service'), [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    exit = once(child, 'exit');
    const ready = once(child, 'message', { signal: AbortSignal.timeout(4500) });
    // Missing model: preload reports failure without blocking service readiness or attempting playback.
    const notRunnable = join(root, 'absent-runtime');
    child.send({ type: 'bootstrap', version: 1, token, workerPath: `${out}/runtime/worker.py`, guardianPath: `${out}/runtime/guardian.py`,
      businessRoot: root, modelsRoot, workspace: { root: workspace, catalog: [] }, speech: { python: notRunnable, model: notRunnable, worker: notRunnable } });
    const [message] = await ready; assert.equal(message.type, 'ready');
    return async (operation = '', body, expectedStatus = 200) => {
      const result = await fetch(`http://127.0.0.1:${message.port}/v1/speech/bubbles${operation}`, {
        method: operation ? 'POST' : 'GET', signal: AbortSignal.timeout(3000),
        headers: { authorization: `Bearer ${token}`, ...(operation && { 'content-type': 'application/json' }) },
        ...(operation && { body: JSON.stringify(body) }),
      });
      assert.equal(result.status, expectedStatus);
      return result.json();
    };
  }
  async function stop() { child.send({ type: 'shutdown' }); assert.deepEqual(await exit, [0, null]); }
  async function checkFailedPreload(request) {
    const deadline = Date.now() + 2_000;
    let result;
    do {
      result = await request();
      if (result.speech?.runtime === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    assert.deepEqual(result, { ok: true, speech: { state: 'enabled', runtime: 'failed', previewAvailable: true, hasReference: true, referenceTranscript: '合成参考稿' } });
  }
  try {
    await mkdir(workspace, { mode: 0o700 });
    await writeFile(join(workspace, 'workspace-state.json'), JSON.stringify({ schemaVersion: 1, revision: 0, theme: 'system', registry: { schemaVersion: 1, instances: [] } }), { mode: 0o600 });
    await writeFile(source, audio, { mode: 0o600 });
    let request = await start();
    assert.equal((await request('/reference', { path: source })).ok, true);
    assert.deepEqual((await request('/transcript', { referenceTranscript: '合成参考稿' })).speech,
      { state: 'disabled', previewAvailable: true, hasReference: true, referenceTranscript: '合成参考稿' });
    assert.deepEqual(await request('/enable', { referenceTranscript: '合成参考稿', speakChatReplies: true }), { ok: false, error: 'invalid' });
    await stop();
    await rm(source);
    request = await start();
    assert.deepEqual(await request(), { ok: true, speech: { state: 'disabled', previewAvailable: true, hasReference: true, referenceTranscript: '合成参考稿' } });
    assert.equal((await request('/enable', { referenceTranscript: '合成参考稿' })).ok, true);
    await checkFailedPreload(request);
    assert.equal((await request('/suspend', {})).speech.state, 'enabled');
    assert.equal((await request('/resume', { preload: false })).speech.state, 'enabled');
    await request('/chat-reply', { revision: 1, text: '不应自动播报' }, 404);
    await stop();
    assert.equal((await stat(join(root, 'speech', 'reference-profile.json'))).mode & 0o777, 0o600);
    request = await start();
    await checkFailedPreload(request);
    await stop();
  } finally {
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exit;
    await rm(root, { recursive: true, force: true });
  }
});
