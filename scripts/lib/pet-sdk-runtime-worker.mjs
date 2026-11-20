import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { validTextEvents } from './pet-sdk-probe-admission.mjs';
import { HARNESS_MODEL as model } from './pet-agent-harness-provider.mjs';
import { watchRuntimeOwner } from './pet-sdk-owner-channel.mjs';
import { HARNESS_VERSION as version } from './pet-sdk-runtime-version.mjs';

const provider = 'pet-loopback';
const standaloneReply = '桌宠 SDK 合成回复';

async function execute(runtimePackage, mode, port, forbiddenPort, canary, variant, sourceCanary, lifetime, resources) {
  assert(['chat', 'standalone'].includes(variant));
  const linked = variant === 'chat';
  const modes = linked ? ['text', 'stop', 'crash', 'disconnect', 'timeout', 'host-loss'] : ['text', 'stop', 'crash'];
  const root = process.env.HOME;
  assert(root && process.env.TMPDIR === root && process.cwd() === root && modes.includes(mode));
  assert([port, forbiddenPort].every(p => Number.isInteger(p) && p > 1024 && p <= 65535) && port !== forbiddenPort);
  assert(/^[a-f0-9]{48}$/.test(process.env.PET_SDK_FIXTURE_KEY ?? ''));
  if (sourceCanary) await assert.rejects(readFile(sourceCanary), { code: 'EPERM' });
  await assert.rejects(readFile(canary), { code: 'EPERM' });
  await assert.rejects(writeFile(canary, 'synthetic write rejected'), { code: 'EPERM' });
  if (linked) await assert.rejects(readFile(join(root, '..', 'service', 'probe-canary.txt')), { code: 'EPERM' });
  await assert.rejects(fetch(`http://127.0.0.1:${forbiddenPort}/`, { signal: AbortSignal.timeout(800) }));
  lifetime.throwIfAborted();
  const fromRuntime = createRequire(resolve(runtimePackage, 'package.json'));
  for (const name of ['@deepseek-ai/dsh-sdk-client', '@deepseek-ai/dsh']) assert.equal(fromRuntime(`${name}/package.json`).version, version);
  const { DeepSeekHarness } = await import(pathToFileURL(fromRuntime.resolve('@deepseek-ai/dsh-sdk-client')).href);
  const workspace = join(root, 'workspace'), dshHome = join(root, 'dsh');
  await mkdir(workspace); await mkdir(dshHome);
  const patch = join(root, 'text-only.yml');
  // Provider log upload and local JSONL are separate capabilities. Disable both.
  const disabled = ['llm-deepseek', 'session-log-deepseek', 'sessions', 'tool-fs', 'tool-working-directory', 'terminal-bash', 'terminal-pwsh', 'persistent-bash', 'persistent-pwsh', 'mcp-resources'];
  await writeFile(patch, `- insert:
    - id: llm-pi-ai
      name: '@deepseek-ai/dsh-llm-pi-ai'
      config:
        providers:
          ${provider}:
            api: openai-completions
            baseURL: http://127.0.0.1:${port}/v1
            apiKeyEnv: PET_SDK_FIXTURE_KEY
            retryPolicy: { mode: normal, maxRetries: 0 }
            models:
              - { id: ${model}, name: Local pet fixture, contextWindow: 8192, maxTokens: 96 }
${disabled.map(id => `- id: ${id}\n  disabled: true`).join('\n')}
- id: agent-loop
  config:
    agents: []
`, { mode: 0o600 });
  lifetime.throwIfAborted();
  const harness = resources.harness = new DeepSeekHarness({ profile: 'sdk-minimal', dshHome, cwd: workspace, processCwd: workspace, patches: [patch], provider, model, maxTokens: 96,
    env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, PET_SDK_FIXTURE_KEY: process.env.PET_SDK_FIXTURE_KEY },
    initializeTimeoutMs: 5000, requestTimeoutMs: mode === 'host-loss' ? 15_000 : 4000, shutdownTimeoutMs: 500, disposeEofGraceMs: 500, disposeGraceMs: 800 });
  const input = resources.input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = input[Symbol.asyncIterator]();
  const first = await lines.next();
  lifetime.throwIfAborted();
  assert(!first.done && Buffer.byteLength(first.value) <= 24_000);
  const text = JSON.parse(first.value);
  assert(typeof text === 'string' && text.trim() && Buffer.byteLength(text) <= 12 * 1024);
  if (mode === 'stop') {
    const result = harness.run(text).then(row => row.finishReason, () => null);
    const command = await lines.next();
    assert.equal(command.value, 'stop');
    await harness.close();
    assert.notEqual(await result, 'completed');
    process.stdin.pause();
    return { status: 'stop', sandboxCanariesDenied: true, textEvents: 0 };
  } else if (mode === 'timeout') {
    const timeout = new AbortController();
    const expired = Symbol('probe worker deadline');
    const result = harness.run(text).catch(() => null);
    try {
      assert.equal(await Promise.race([result, delay(3000, expired, { signal: timeout.signal })]), expired);
      await harness.close();
      assert.notEqual((await result)?.finishReason, 'completed');
    } finally { timeout.abort(); }
    return { status: 'timeout', sandboxCanariesDenied: true, textEvents: 0 };
  } else if (mode === 'disconnect') {
    const result = await harness.run(text);
    assert.equal(result.finishReason, 'error');
    return { status: 'disconnect', sandboxCanariesDenied: true, textEvents: 0 };
  } else if (mode === 'host-loss') {
    await harness.run(text);
    assert.fail('host-loss fixture must remain in flight');
  } else {
    const result = await harness.run(text);
    assert.equal(result.finishReason, 'completed');
    if (!linked) assert.equal(result.finalResponse, standaloneReply);
    else assert(typeof result.finalResponse === 'string');
    assert(validTextEvents(result.events), 'text events invalid');
    return { status: 'completed', sandboxCanariesDenied: true, textEvents: result.events.length,
      ...(linked ? { finalText: result.finalResponse } : {}) };
  }

}


async function main() {
  assert(process.platform === 'darwin', 'macOS sandbox required');
  const owner = watchRuntimeOwner();
  const resources = {};
  let onLost;
  try {
    owner.signal.throwIfAborted();
    const [directory, mode, port, forbiddenPort, canary, variant, sourceCanary] = process.argv.slice(2);
    const lost = new Promise(resolve => {
      onLost = () => resolve(undefined);
      owner.signal.addEventListener('abort', onLost, { once: true });
    });
    let frame;
    try {
      frame = await Promise.race([
        execute(directory, mode, Number(port), Number(forbiddenPort), canary, variant, sourceCanary, owner.signal, resources), lost,
      ]);
    } finally {
      resources.input?.close();
      process.stdin.destroy();
      // SDK owns its ChildProcess and confirms shutdown before this Worker leaves.
      await resources.harness?.close();
    }
    if (!owner.signal.aborted && frame) console.log(JSON.stringify(frame));
  } catch (error) {
    if (!owner.signal.aborted) {
      const missing = /Cannot find (?:package|module) ['"](@?[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)?)['"]/i.exec(String(error?.message))?.[1];
      const kind = missing ? `missing_dependency:${missing}` : error?.name === 'AssertionError' ? 'verification_failure' : 'sdk_failure';
      console.log(JSON.stringify({ error: kind }));
      process.exitCode = 1;
    }
  } finally {
    if (onLost) owner.signal.removeEventListener('abort', onLost);
    owner.dispose();
    if (process.connected) process.disconnect();
  }
}
await main();
