import { fileURLToPath } from 'node:url';
import { createHarnessRuntime } from '../../src/agent/harness-runtime.ts';

const worker = fileURLToPath(new URL('../../src/agent/harness-worker.mjs', import.meta.url));
try {
  await createHarnessRuntime({ worker })('临时合成宿主失联', async () => {
    process.send?.({ dispatched: true });
    return new Promise(() => {});
  }, AbortSignal.timeout(8000));
} catch { process.exitCode = 1; }
finally { if (process.connected) process.disconnect(); }
