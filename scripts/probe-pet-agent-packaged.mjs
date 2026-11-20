/** Offline macOS arm64 bundle probe; no Electron launch, account, or distribution. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { stageElectronMacApp } from './lib/pet-electron-macos-stage.mjs';
import { HARNESS_VERSION, stageProductHarnessRuntime } from './lib/pet-sdk-runtime-stage.mjs';

const run = promisify(execFile);
const codesign = args => run('/usr/bin/codesign', args, { timeout: 120_000, maxBuffer: 64 * 1024 });
const sign = path => codesign(['--force', '--sign', '-', '--timestamp=none', path]);
async function signFixture(app, harnessNode) {
  const frameworks = join(app, 'Contents/Frameworks');
  // Fixed Electron framework children that need their own signature before the container.
  for (const path of [
    'Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib',
    'Electron Framework.framework/Versions/A/Libraries/libvk_swiftshader.dylib',
    'Electron Framework.framework/Versions/A/Helpers/app_shim_loader',
    'Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler',
    'Squirrel.framework/Versions/A/Resources/ShipIt',
  ]) await sign(join(frameworks, path));
  for (const entry of await readdir(frameworks, { withFileTypes: true })) {
    if (entry.isDirectory() && /\.(framework|app)$/.test(entry.name)) await sign(join(frameworks, entry.name));
  }
  await sign(harnessNode);
  await sign(app);
}

assert(process.platform === 'darwin' && process.arch === 'arm64', 'this probe requires macOS arm64');
const [major, minor] = process.versions.node.split('.').map(Number);
assert(!process.versions.electron && major === 24 && minor >= 9, 'use standalone Node 24.9+');
const args = process.argv.slice(2);
const omitWebSourceMaps = args.length === 1 && args[0] === '--omit-web-source-maps';
assert(args.length === 0 || omitWebSourceMaps, 'usage: node scripts/probe-pet-agent-packaged.mjs [--omit-web-source-maps]');
const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const service = join(root, 'apps/app-service');
assert.deepEqual(await readFile(join(service, 'dist/harness-worker.mjs')), await readFile(join(service, 'src/agent/harness-worker.mjs')), 'build the current service first');
const electronPackage = dirname(createRequire(import.meta.url).resolve('electron/package.json'));
const { version: electron } = JSON.parse(await readFile(join(electronPackage, 'package.json'), 'utf8'));
assert.equal((await readFile(join(electronPackage, 'dist/version'), 'utf8')).trim(), electron, 'install the matching Electron binary before running this probe');
const electronApp = join(electronPackage, 'dist/Electron.app');
assert.equal((await run('/usr/bin/lipo', ['-archs', join(electronApp, 'Contents/MacOS/Electron')])).stdout.trim(), 'arm64');
const originalNode = await realpath(process.execPath);
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'pet-agent-packaged-')));
const staged = join(scratch, 'Signing Fixture.app'), moved = join(scratch, 'Moved Signing Fixture.app');
const turns = join(scratch, 'turns'), home = join(scratch, 'synthetic-data');
let started = false;
try {
  const { appRoot, harnessNode, stats } = await stageElectronMacApp({
    electronApp, outputApp: staged, desktopDist: join(root, 'apps/desktop/dist'), servicePackage: service,
    nodeExecutable: originalNode,
    stageRuntime: (source, destination) => stageProductHarnessRuntime(source, destination, { omitWebSourceMaps }),
  });
  const probeRel = 'apps/app-service/dist/probe.cjs';
  await build({ absWorkingDir: root, entryPoints: ['scripts/lib/pet-sdk-relocated-chat.mjs'],
    outfile: join(appRoot, probeRel), bundle: true, packages: 'external', platform: 'node', format: 'cjs', target: 'node24' });
  await signFixture(staged, harnessNode);
  await rename(staged, moved);
  const executable = join(moved, relative(staged, harnessNode));
  const movedAppRoot = join(moved, relative(staged, appRoot));
  await codesign(['--verify', '--deep', '--strict', moved]);
  await codesign(['--verify', '--strict', executable]);
  assert.equal(createRequire(join(movedAppRoot, 'dist/main.cjs')).resolve('@pet/app-service'), join(movedAppRoot, 'apps/app-service/dist/entry.cjs'));
  const nodeBytes = (await stat(executable)).size;
  await Promise.all([mkdir(turns), mkdir(home)]);
  started = true;
  const { stdout } = await run(executable, ['--no-global-search-paths', join(movedAppRoot, probeRel), root, originalNode, 'mac-app'], {
    cwd: movedAppRoot, env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: turns }, timeout: 30_000, maxBuffer: 16 * 1024,
  });
  console.log(JSON.stringify({ electron, sdk: HARNESS_VERSION, adHocSignatureVerified: true, relocated: true,
    electronLaunched: false, omitWebSourceMaps, ...stats, nodeBytes, ...JSON.parse(stdout) }, null, 2));
} catch (error) {
  if (error.stderr) console.error(error.stderr.trim());
  throw error;
} finally {
  if (!started || (await readdir(turns)).length === 0) await rm(scratch, { recursive: true, force: true });
  else console.error(`SDK turn cleanup was not confirmed; kept ${scratch}`);
}
