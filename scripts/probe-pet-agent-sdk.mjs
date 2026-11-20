import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir, userInfo } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createFixtureAdmission } from './lib/pet-sdk-probe-admission.mjs';
import { HARNESS_MODEL, parseHarnessRequest } from './lib/pet-agent-harness-provider.mjs';
import { stageHarnessRuntime } from './lib/pet-sdk-runtime-stage.mjs';
import { HARNESS_VERSION as version } from './lib/pet-sdk-runtime-version.mjs';

// Explicit opt-in, never imported by a product entry point. No accounts, SDK install, or external provider.
const model = HARNESS_MODEL;
const standaloneReply = '桌宠 SDK 合成回复';
const standalonePrompt = mode => `桌宠 SDK 合成正文：${mode}`;
const script = fileURLToPath(import.meta.url);
const standaloneModes = ['text', 'stop', 'crash'];
const chatModes = [...standaloneModes, 'disconnect', 'timeout'];
const maxBody = 24_000;

function providerReply(res, text) {
  const chunk = (delta, finish_reason) => `data: ${JSON.stringify({ id: 'local-fixture-turn', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
  res.end(chunk({ role: 'assistant', content: text }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
}

async function listen(server) {
  server.maxConnections = 8;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return server.address().port;
}

async function inspectArtifacts(root, needles) {
  const found = needles.map(() => false);
  let bytes = 0, files = 0;
  async function visit(path, depth) {
    assert(depth <= 12, 'probe artifact tree too deep');
    for (const name of await readdir(path)) {
      const item = join(path, name), info = await lstat(item);
      if (info.isDirectory()) { await visit(item, depth + 1); continue; }
      assert(info.isFile() && info.nlink === 1, 'unexpected probe artifact type');
      files++; bytes += info.size;
      assert(files <= 128 && bytes <= 1024 * 1024, 'probe artifact limit');
      const content = await readFile(item);
      for (const [i, needle] of needles.entries()) found[i] ||= content.includes(needle) || content.includes(JSON.stringify(needle).slice(1, -1));
    }
  }
  await visit(root, 0);
  return { files, promptOnDisk: found[0], replyOnDisk: found[1], capabilityOnDisk: found[2], privateMarkersOnDisk: found.slice(3).some(Boolean) };
}

async function groupExited(pid) {
  for (let i = 0; i < 50; i++) {
    try { process.kill(-pid, 0); } catch (error) {
      if (error.code === 'ESRCH') return true;
      return false;
    }
    await delay(25);
  }
  return false;
}

async function audit(runtimePackage, createChatFixture, stage) {
  const linked = !!createChatFixture;
  const modes = stage ? [...chatModes, 'host-loss'] : linked ? chatModes : standaloneModes;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pet-sdk-probe-')));
  let removable = true;
  const canary = join(root, 'outside.txt');
  let hits = 0;
  const forbidden = createServer((_, res) => { hits++; res.end(); });
  let active, chatFixture;
  const server = createServer(async (req, res) => {
    const reject = status => { req.resume(); res.writeHead(status, { connection: 'close' }).end(); };
    const current = active;
    if (!current || current.signal?.aborted || req.headers.authorization !== `Bearer ${current.capability}`) return reject(403);
    current.authenticatedRequests++;
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions' || req.headers.host !== `127.0.0.1:${port}` ||
        req.headers.origin || req.headers['content-type'] !== 'application/json') return reject(403);
    let size = 0;
    const chunks = [];
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBody) { res.destroy(); return; }
        chunks.push(chunk);
      }
      if (active !== current || res.destroyed) return reject(403);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      let admittedText;
      if (linked) {
        if (current.requests) return reject(409);
        const match = parseHarnessRequest(body, current.workspace, current.text);
        if (!match.ok) return reject(422);
        admittedText = match.text;
      } else {
        const result = current.admit(req.headers.authorization, body);
        if (result !== 'admitted') return reject(result === 'used' || result === 'stale' ? 409 : 422);
      }
      current.requests++;
      req.socket.once('close', () => { current.connectionClosed = true; current.disconnected(); });
      if (linked) {
        const generation = current.request(admittedText);
        // Make stop/crash/timeout test an in-flight dispatch, not a startup failure.
        const dispatched = await Promise.race([current.dispatched.then(() => true), generation.then(() => false, () => false)]);
        if (dispatched) current.arrived();
        const text = await generation.catch(() => undefined);
        if (res.destroyed || current.signal.aborted || active !== current) return;
        if (typeof text === 'string') providerReply(res, text);
        else reject(502);
      } else {
        current.arrived();
        if (current.mode === 'text') providerReply(res, standaloneReply);
      }
    } catch { if (!res.destroyed) reject(400); }
  });
  let port;
  const admission = createFixtureAdmission();
  const evidence = {};
  try {
    await writeFile(canary, 'outside-sandbox-synthetic', { mode: 0o600 });
    const forbiddenPort = await listen(forbidden);
    port = await listen(server);
    const sdkStore = await realpath(resolve(runtimePackage, stage ? 'node_modules' : '../../node_modules'));
    const sourceWorker = new URL('./lib/pet-sdk-runtime-worker.mjs', import.meta.url);
    const worker = stage ? join(runtimePackage, 'pet-sdk-runtime-worker.mjs') : fileURLToPath(sourceWorker);
    const workerFiles = stage ? [worker] : [worker, ...['pet-sdk-probe-admission.mjs', 'pet-agent-harness-provider.mjs', 'pet-sdk-owner-channel.mjs', 'pet-sdk-runtime-version.mjs']
      .map(name => fileURLToPath(new URL(name, sourceWorker)))];
    const node = await realpath(process.execPath);
    const accountHome = await realpath(userInfo().homedir);
    if (linked) {
      const fixtureRoot = join(root, 'service');
      await mkdir(fixtureRoot, { mode: 0o700 });
      await writeFile(join(fixtureRoot, 'probe-canary.txt'), 'service-only-synthetic', { mode: 0o600 });
      chatFixture = createChatFixture(fixtureRoot);
      await chatFixture.initialize();
    }
    async function startWorker(mode, { capability, text, admit, request, dispatched, signal, replyMarker, privateMarkers = [] }) {
      const runRoot = join(root, mode);
      await mkdir(runRoot, { mode: 0o700 });
      let stdout = '', timer, finalText, launcherKilledAt, ioOverflow = false;
      const pending = Promise.withResolvers(), disconnected = Promise.withResolvers();
      const current = active = { mode, capability, text, admit, request, dispatched, signal, workspace: join(runRoot, 'workspace'), arrived: pending.resolve, disconnected: disconnected.resolve,
        authenticatedRequests: 0, requests: 0, connectionClosed: false };
      const quote = JSON.stringify;
      const policy = `(version 1) (allow default) (deny network*)
        (allow network-outbound (remote ip "localhost:${port}"))
        (deny file-read-data (subpath ${quote(accountHome)}) (literal ${quote(canary)}))
        ${linked ? `(deny file-read-data (subpath ${quote(join(root, 'service'))}))` : ''}
        ${stage ? `(deny file-read-data (subpath ${quote(stage.reference)}))` : ''}
        (allow file-read-data
          (literal ${[node, join(runtimePackage, 'package.json'), ...workerFiles].map(quote).join(' ')})
          (subpath ${[runRoot, sdkStore, join(runtimePackage, 'node_modules'), ...(stage ? [runtimePackage] : [])].map(quote).join(' ')}))
        (deny file-write*) (allow file-write* (subpath ${quote(runRoot)}))`;
      const sandboxArgs = ['-p', policy, node, worker, runtimePackage, mode, String(port), String(forbiddenPort), canary, linked ? 'chat' : 'standalone', ...(stage ? [stage.sourceManifest] : [])];
      const hostLoss = mode === 'host-loss';
      const options = { cwd: runRoot, stdio: ['pipe', 'pipe', 'ignore', 'ipc'],
        env: { PATH: '/usr/bin:/bin', HOME: runRoot, TMPDIR: runRoot, PET_SDK_FIXTURE_KEY: capability } };
      const child = hostLoss ? spawn(node, [script, '--fixture-owner', ...sandboxArgs], options)
        : spawn('/usr/bin/sandbox-exec', sandboxArgs, { ...options, detached: true });
      let workerPID = hostLoss ? undefined : child.pid;
      const workerIdentity = hostLoss ? once(child, 'message').then(([message]) => {
        assert(message && Number.isSafeInteger(message.workerPID) && message.workerPID > 1 && message.workerPID !== child.pid, 'invalid fixture worker ID');
        workerPID = message.workerPID;
        return workerPID;
      }) : Promise.resolve(workerPID);
      void workerIdentity.catch(() => {});
      const exited = once(child, 'close');
      const stopOwned = () => {
        if (child.exitCode === null && child.signalCode === null && child.pid) child.kill('SIGKILL');
      };
      signal?.addEventListener('abort', stopOwned, { once: true });
      if (signal?.aborted) stopOwned();
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SDK probe deadline')), 13_000); });
      child.stdin.on('error', () => {});
      child.stdin.write(`${JSON.stringify(text)}\n`);
      if (mode !== 'stop') child.stdin.end();
      child.stdout.setEncoding('utf8').on('data', chunk => {
        if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > 50 * 1024) { ioOverflow = true; child.kill('SIGKILL'); return; }
        stdout += chunk;
      });
      let resultEvidence;
      try {
        const sent = await Promise.race([deadline, pending.promise.then(() => true), exited.then(() => false)]);
        if (!sent) {
          const diagnostic = /^[\s]*\{"error":"(verification_failure|sdk_failure|missing_dependency:@?[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)?)"\}[\s]*$/.exec(stdout)?.[1];
          assert.fail(`SDK ${mode} exited before dispatch (${diagnostic ?? 'no verified worker status'}; ${current.authenticatedRequests} authenticated requests, ${current.requests} accepted envelopes)`);
        }
        if (hostLoss) {
          await Promise.race([workerIdentity, deadline]);
          assert(!current.connectionClosed, 'test provider must still be hanging');
          launcherKilledAt = performance.now();
          assert(child.kill('SIGKILL'), 'could not signal the owned launcher host');
        } else if (mode === 'stop') child.stdin.end('stop\n');
        else if (mode === 'crash') assert(child.kill('SIGKILL'), 'could not signal the owned fixture worker');
        const [code, signal] = await Promise.race([deadline, exited]);
        assert(!ioOverflow, 'probe output limit');
        const drain = new AbortController();
        try { await Promise.race([disconnected.promise, delay(hostLoss ? 3000 : 1000, undefined, { signal: drain.signal })]); }
        finally { drain.abort(); }
        assert(current.connectionClosed, 'fixture connection must close');
        resultEvidence = { outcome: mode === 'text' ? 'completed' : 'outcome-unknown', fixtureConnectionClosed: true };
        if (hostLoss) {
          assert.equal(signal, 'SIGKILL');
          resultEvidence.launcherKilled = true;
        } else if (mode === 'crash') assert.equal(signal, 'SIGKILL');
        else {
          assert.equal(code, 0, `SDK ${mode} failed`);
          let result;
          try { result = JSON.parse(stdout.trim()); } catch { throw new Error('unexpected fixture worker output'); }
          assert(result?.sandboxCanariesDenied === true, 'sandbox canaries not confirmed');
          assert.equal(result.status, mode === 'text' ? 'completed' : mode);
          assert(Number.isInteger(result.textEvents) && (mode === 'text' ? result.textEvents > 0 && result.textEvents <= 64 : result.textEvents === 0), 'invalid event count');
          resultEvidence.sandboxCanariesDenied = true;
          const keys = ['status', 'sandboxCanariesDenied', 'textEvents', ...(linked && mode === 'text' ? ['finalText'] : [])];
          assert(Object.keys(result).length === keys.length && Object.keys(result).every(key => keys.includes(key)), 'invalid worker frame');
          if (mode === 'text') {
            resultEvidence.textEvents = result.textEvents;
            if (linked) {
              assert(typeof result.finalText === 'string' && result.finalText.trim() && Buffer.byteLength(result.finalText) <= 24 * 1024, 'invalid runtime terminal');
              finalText = result.finalText;
            }
          }
        }
      } finally {
        clearTimeout(timer);
        active = undefined;
        // Signal only a live Node child handle, never a guessed or stale group ID.
        signal?.removeEventListener('abort', stopOwned);
        stopOwned();
        child.stdin.destroy(); child.stdout.destroy();
        if ((hostLoss && !workerPID) || (workerPID && !(await groupExited(workerPID)))) {
          removable = false;
          if (stage) stage.preserve = true;
          console.error(`Unconfirmed Worker group; retained ${root}`);
          throw new Error(`SDK ${mode} process-group exit unconfirmed (${workerPID ?? 'identity missing'}); temporary files retained`);
        }
      }
      if (launcherKilledAt !== undefined) resultEvidence.launcherLossToGroupExitMs = Math.ceil(performance.now() - launcherKilledAt);
      assert.equal(current.requests, 1, 'one admitted request per attempt');
      assert.equal(current.authenticatedRequests, 1, 'no authenticated retry, including rejected duplicates');
      const markers = [text, replyMarker, capability, ...privateMarkers];
      assert(![text, capability, ...privateMarkers].some(marker => stdout.includes(marker) || stdout.includes(JSON.stringify(marker).slice(1, -1))), 'unexpected marker in worker output');
      const artifacts = await inspectArtifacts(runRoot, markers);
      const { promptOnDisk, replyOnDisk, capabilityOnDisk, privateMarkersOnDisk } = artifacts;
      assert(!promptOnDisk && !replyOnDisk && !capabilityOnDisk && !privateMarkersOnDisk,
        `SDK ${mode} wrote a synthetic transcript or capability marker to disk`);
      return { ...resultEvidence, authenticatedRequests: current.authenticatedRequests, processGroupExited: true, artifacts, ...(finalText !== undefined ? { finalText } : {}) };
    }
    for (const mode of modes) {
      if (linked) evidence[mode] = await chatFixture.run(mode, options => startWorker(mode, options));
      else {
        const bound = admission.open({ petID: 'fixture-pet', requestID: randomUUID(), model, revision: 1, text: standalonePrompt(mode) }, () => 1);
        try { evidence[mode] = await startWorker(mode, { capability: bound.capability, admit: bound.claim, text: standalonePrompt(mode), replyMarker: standaloneReply }); }
        finally { bound.close(); }
      }
    }
    assert.equal(hits, 0, 'sandbox made an out-of-scope request');
    assert.equal(await readFile(canary, 'utf8'), 'outside-sandbox-synthetic');
    if (linked) assert.equal(await readFile(join(root, 'service', 'probe-canary.txt'), 'utf8'), 'service-only-synthetic');
    console.log(JSON.stringify({ version, syntheticRequests: modes.length, automaticReplay: false,
      networkCanaryHits: hits, linkedChat: linked, ...(stage ? { stagedPackages: stage.packages, stagedPayloadBytes: stage.payloadBytes, stagedPayloadFiles: stage.payloadFiles, relocated: true } : {}), evidence, productionEnabled: false }));
  } finally {
    for (const fixture of [server, forbidden]) {
      fixture.closeAllConnections(); if (fixture.listening) await new Promise(resolve => fixture.close(resolve));
    }
    await chatFixture?.close();
    if (removable) await rm(root, { recursive: true, force: true });
  }
}


assert(process.platform === 'darwin', 'This probe requires the macOS sandbox launcher.');
const [arg, directory, extra] = process.argv.slice(2);
if (arg === '--fixture-owner') {
  // Disposable launcher process only. The outer auditor never signals the Worker group.
  assert(process.connected && typeof process.send === 'function');
  const worker = spawn('/usr/bin/sandbox-exec', process.argv.slice(3), { detached: true, stdio: ['pipe', 'ignore', 'ignore', 'ipc'] });
  worker.stdin.on('error', () => {});
  worker.on('error', () => { process.exitCode = 1; if (process.connected) process.disconnect(); });
  worker.once('spawn', () => process.send?.({ workerPID: worker.pid }, () => {}));
  process.stdin.pipe(worker.stdin);
  process.once('disconnect', () => { if (worker.connected) worker.disconnect(); });
  worker.once('close', () => { if (process.connected) process.disconnect(); });
} else if (arg === '--chat' || arg === '--staged') {
  assert(directory && !extra, 'Usage: pnpm exec tsx scripts/probe-pet-agent-sdk.mjs --chat|--staged <trusted Ape runtime-deepseek directory>');
  const { createSdkChatFixture } = await import('./lib/pet-sdk-chat-fixture.mjs');
  const installed = await realpath(directory);
  if (arg === '--chat') await audit(installed, createSdkChatFixture);
  else {
    const stageRoot = await realpath(await mkdtemp(join(tmpdir(), 'pet-sdk-stage-')));
    let stage;
    try {
      const prepared = join(stageRoot, 'prepared'), relocated = join(stageRoot, 'relocated');
      const stats = await stageHarnessRuntime(installed, prepared);
      await rename(prepared, relocated);
      stage = { ...stats, reference: resolve(installed, '../..'), sourceManifest: join(installed, 'package.json') };
      await audit(relocated, createSdkChatFixture, stage);
    } finally {
      if (stage?.preserve) console.error(`Staged verification not confirmed; retained ${stageRoot}`);
      else await rm(stageRoot, { recursive: true, force: true });
    }
  }
} else {
  assert(arg && !directory, 'Usage: node scripts/probe-pet-agent-sdk.mjs <trusted Ape runtime-deepseek directory>');
  await audit(await realpath(arg));
}
