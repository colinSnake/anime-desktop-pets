/** Offline macOS acceptance probe. No app launch, provider account, or retained distribution. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { HARNESS_VERSION, stageProductHarnessRuntime } from './lib/pet-sdk-runtime-stage.mjs';

assert.equal(process.platform, 'darwin', 'this probe uses the macOS product sandbox');
const [major, minor] = process.versions.node.split('.').map(Number);
assert(!process.versions.electron && major === 24 && minor >= 9, 'use standalone Node 24.9+');
const args = process.argv.slice(2);
const omitWebSourceMaps = args.length === 1 && args[0] === '--omit-web-source-maps';
assert(args.length === 0 || omitWebSourceMaps, 'usage: node scripts/probe-pet-agent-relocated.mjs [--omit-web-source-maps]');
assert(!omitWebSourceMaps || process.arch === 'arm64', 'the web source-map trial requires macOS arm64');
const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const service = join(root, 'apps', 'app-service');
const worker = join(service, 'dist', 'harness-worker.mjs');
assert.deepEqual(await readFile(worker), await readFile(join(service, 'src', 'agent', 'harness-worker.mjs')), 'build the current service first');
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'pet-agent-relocation-')));
const temp = join(scratch, 'turns');
let started = false;
try {
  const stage = join(scratch, 'prepared'), moved = join(scratch, 'relocated runtime');
  const home = join(scratch, 'synthetic-data');
  const stats = await stageProductHarnessRuntime(service, stage, { omitWebSourceMaps });
  const dist = join(stage, 'apps', 'app-service', 'dist');
  const node = join(stage, 'bin', 'node');
  await Promise.all([mkdir(join(stage, 'bin')), mkdir(dist), mkdir(home), mkdir(temp)]);
  const originalNode = await realpath(process.execPath);
  await copyFile(originalNode, node);
  await copyFile(worker, join(dist, 'harness-worker.mjs'));
  await build({ absWorkingDir: root, entryPoints: ['scripts/lib/pet-sdk-relocated-chat.mjs'],
    outfile: join(dist, 'probe.cjs'), bundle: true, packages: 'external', platform: 'node', format: 'cjs', target: 'node24' });
  const nodeBytes = (await stat(node)).size;
  await rename(stage, moved);
  started = true;
  const { stdout } = await promisify(execFile)(join(moved, 'bin', 'node'), ['--no-global-search-paths', join(moved, 'apps/app-service/dist/probe.cjs'), root, originalNode], {
    cwd: moved, env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: temp }, timeout: 30_000, maxBuffer: 16 * 1024,
  });
  console.log(JSON.stringify({ sdk: HARNESS_VERSION, omitWebSourceMaps, ...stats, nodeBytes, ...JSON.parse(stdout) }, null, 2));
} finally {
  if (!started || (await readdir(temp)).length === 0) await rm(scratch, { recursive: true, force: true });
  else console.error(`SDK turn cleanup was not confirmed; kept ${scratch}`);
}
