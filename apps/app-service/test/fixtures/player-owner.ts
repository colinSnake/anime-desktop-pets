/** Test-only owner process; stdlib synthetic worker, never a real desktop. */
import { join, resolve } from "node:path";
import { PlayerRuntime } from "../../src/player-runtime.ts";
const root = process.argv[2]!;
const runtime = new PlayerRuntime({ guardianPath: resolve("apps/runtime-bridge/guardian.py"),
  workerPath: join(root, "hang.py"), python: process.env.PET_PYTHON, platform: "darwin", timeoutMs: 30_000,
  config: { source: root, assets: root, profileRoot: join(root, "sessions") } });
void runtime.start();
setInterval(() => { if (runtime.pid) process.send?.({ pid: runtime.pid }); }, 20);
