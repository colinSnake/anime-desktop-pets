import { chmod, cp, lstat, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { stageProductHarnessRuntime } from './pet-sdk-runtime-stage.mjs';

const copyOptions = { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true };
const localDesktopAssets = new Set(['startup/startup.mp4', 'branding/pet-cover.png']);

/** Stage a throwaway, unpacked macOS bundle. This is not a distribution builder. */
export async function stageElectronMacApp({
  electronApp,
  outputApp,
  desktopDist,
  servicePackage,
  nodeExecutable,
  stageRuntime = stageProductHarnessRuntime,
}) {
  // errorOnExist + force:false rejects an existing top-level bundle.
  await cp(electronApp, outputApp, copyOptions);
  const appRoot = join(outputApp, 'Contents/Resources/app');
  const harnessNode = join(outputApp, 'Contents/Helpers/pet-harness-node');
  const stats = await stageRuntime(servicePackage, appRoot);
  const copyDist = async (source, destination, excluded = new Set()) => cp(source, destination, {
    ...copyOptions,
    filter: async file => {
      if (excluded.has(relative(source, file).split(sep).join('/'))) return false;
      const info = await lstat(file);
      if (!info.isDirectory() && !info.isFile()) throw new Error('unexpected build output link or special file');
      return true;
    },
  });
  const stagedService = join(appRoot, 'apps/app-service');
  await copyDist(desktopDist, join(appRoot, 'dist'), localDesktopAssets);
  await cp(join(servicePackage, 'package.json'), join(stagedService, 'package.json'), { errorOnExist: true, force: false });
  await copyDist(join(servicePackage, 'dist'), join(stagedService, 'dist'));
  await mkdir(join(appRoot, 'node_modules/@pet'), { recursive: true });
  await symlink('../../apps/app-service', join(appRoot, 'node_modules/@pet/app-service'));
  await mkdir(join(outputApp, 'Contents/Helpers'), { recursive: true });
  await cp(nodeExecutable, harnessNode, { errorOnExist: true, force: false });
  await chmod(harnessNode, 0o755);
  await writeFile(join(appRoot, 'package.json'), JSON.stringify({ name: 'anime-desktop-pets', private: true, main: 'dist/main.cjs' }), { flag: 'wx' });
  return { appRoot, harnessNode, stats };
}
