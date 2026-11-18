/** 构建仅写本次暂存目录，全部成功后提升；不启动桌面或生成安装包。 */
import { build as bundle } from 'esbuild';
import { build as buildUI } from 'vite';
import { mkdir, mkdtemp, copyFile, rename, rm, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

/** 两个包不能一次 rename；普通发布错误时逆序恢复。若恢复也失败则保留备份。 */
export async function publishBuild(outputs, move = rename) {
  const changes = [];
  try {
    for (const output of outputs) {
      const change = { ...output, backedUp: false, promoted: false };
      changes.push(change);
      try { await move(output.target, output.backup); change.backedUp = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await move(output.stage, output.target);
      change.promoted = true;
    }
  } catch (error) {
    const errors = [];
    for (const change of changes.reverse()) {
      try {
        if (change.promoted) await move(change.target, change.stage);
        if (change.backedUp) await move(change.backup, change.target);
      } catch (restoreError) { errors.push(restoreError); }
    }
    if (errors.length) throw Object.assign(new AggregateError([error, ...errors], '构建提升及恢复失败，暂存目录与备份已保留。'), { preserveStaging: true });
    throw error;
  }
}

export async function buildCrossPlatform(root, tools = { bundle, buildUI }) {
  await mkdir(join(root, '.local'), { recursive: true });
  const staging = await mkdtemp(join(root, '.local', 'cross-platform-build-'));
  let preserve = false;
  try {
    const desktop = join(staging, 'desktop');
    const service = join(staging, 'service');
    await mkdir(join(desktop, 'runtime'), { recursive: true });
    await mkdir(service);
    for (const [entry, output] of [
      ['apps/desktop/src/main.ts', join(desktop, 'main.cjs')],
      ['apps/desktop/src/preload.ts', join(desktop, 'preload.cjs')],
      ['apps/app-service/src/entry.ts', join(service, 'entry.cjs')],
    ]) {
      await tools.bundle({
        absWorkingDir: root, entryPoints: [entry], outfile: output,
        bundle: true, platform: 'node', format: 'cjs', target: 'node24',
        packages: 'external', sourcemap: false, logLevel: 'info',
      });
    }
    for (const name of ['worker.py', 'guardian.py', 'player_worker.py', 'player_protocol.py', 'player_adapter.py', 'pet_cover.py']) {
      await copyFile(join(root, 'apps/runtime-bridge', name), join(desktop, 'runtime', name));
    }
    for (const name of ['pet_sources.py', 'pet_library.py', 'pet_reference_lock.py']) {
      await copyFile(join(root, 'apps/pet-runtime/pets', name), join(desktop, 'runtime', name));
    }
    await tools.buildUI({
      configFile: false, root: join(root, 'apps/workspace-ui'), base: './',
      build: { outDir: join(desktop, 'ui'), emptyOutDir: true, sourcemap: false },
    });
    for (const path of ['main.cjs', 'preload.cjs', 'ui/index.html', 'runtime/worker.py', 'runtime/guardian.py', 'runtime/player_worker.py', 'runtime/player_protocol.py', 'runtime/player_adapter.py', 'runtime/pet_cover.py', 'runtime/pet_sources.py', 'runtime/pet_library.py', 'runtime/pet_reference_lock.py']) await access(join(desktop, path));
    await access(join(service, 'entry.cjs'));
    await publishBuild([
      { stage: service, target: join(root, 'apps/app-service/dist'), backup: join(staging, 'service-previous') },
      { stage: desktop, target: join(root, 'apps/desktop/dist'), backup: join(staging, 'desktop-previous') },
    ]);
    // 成功替换的 desktop dist 自然不再包含旧 service.cjs；不触碰其他构建。
  } catch (error) {
    preserve = error.preserveStaging === true;
    if (preserve) console.error(`恢复所需暂存目录：${staging}`);
    throw error;
  } finally {
    if (!preserve) await rm(staging, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildCrossPlatform(fileURLToPath(new URL('../', import.meta.url)));
}
