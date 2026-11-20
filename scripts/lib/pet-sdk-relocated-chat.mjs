// Bundled into a disposable stage; never imported by the desktop or service entry.
import assert from 'node:assert/strict';
import { readdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveHarnessExecutable } from '../../apps/desktop/src/harness-node.ts';
import { ModelError } from '../../apps/app-service/src/models/errors.ts';
import { createHarnessRuntime } from '../../apps/app-service/src/agent/harness-runtime.ts';
import { createSdkChatFixture } from './pet-sdk-chat-fixture.mjs';

async function main() {
  const { HOME, TMPDIR } = process.env;
  const [checkout, originalNode, layout] = process.argv.slice(2);
  assert(HOME && TMPDIR && checkout && originalNode);
  const stage = await realpath(process.cwd());
  assert.equal(__dirname, join(stage, 'apps', 'app-service', 'dist'));
  const executable = layout === 'mac-app' ? resolveHarnessExecutable({ platform: process.platform, packaged: true,
    resourcesPath: dirname(stage), environment: { PET_HARNESS_NODE: originalNode } }) : join(stage, 'bin', 'node');
  assert.equal(await realpath(process.execPath), executable);
  const runtime = createHarnessRuntime({ worker: join(__dirname, 'harness-worker.mjs'), executable, privateRoots: [checkout, originalNode, HOME] });
  const fixture = createSdkChatFixture(HOME);
  const outcomes = [];
  try {
    await fixture.initialize();
    for (const mode of ['text', 'disconnect']) {
      const outcome = await fixture.run(mode, async ({ text, request, signal }) => {
        try {
          const finalText = await runtime(text, request, signal);
          assert.equal(mode, 'text');
          return { finalText };
        } catch (error) {
          if (mode !== 'disconnect' || !(error instanceof ModelError) || error.code !== 'upstream_unavailable') throw error;
          return {};
        }
      }, mode === 'text' ? { text: '/help', expectMemory: false } : undefined);
      assert.deepEqual(await readdir(TMPDIR), [], 'SDK turn root was not removed');
      outcomes.push({ mode, ...outcome });
    }
    console.log(JSON.stringify({ node: process.versions.node, arch: process.arch, outcomes }));
  } finally {
    await fixture.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
