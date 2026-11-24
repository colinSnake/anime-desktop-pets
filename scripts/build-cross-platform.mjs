/** 构建仅写本次暂存目录，全部成功后提升；不启动桌面或生成安装包。 */
import { build as bundle } from 'esbuild';
import { build as buildUI } from 'vite';
import { mkdir, mkdtemp, copyFile, rename, rm, access, lstat, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stageStartupVideo } from './stage-startup-video.mjs';
import { stageVideoUI } from './stage-video-ui.mjs';

const approvedLongmeiCovers = new Set([
  '42616c6d59356906d5477a85a52647a044cf5dcfa995fa2dd82be62845887104', // Original / rollback.
  '0e91b704b1114522001d4211c9590cf02861075b52428102ec2731d6fb5e2c88', // Local 2× cover.
]);

async function buildMacHelper(root, source, output) {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x86_64' : undefined;
  if (!arch) throw new Error('unsupported_native_build_architecture');
  await promisify(execFile)('/usr/bin/xcrun', ['--sdk', 'macosx', 'swiftc', '-O', '-target', `${arch}-apple-macosx13.0`,
    join(root, source), '-o', output], { timeout: 120_000 });
}

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
        // The service exports CommonJS for Electron utilityProcess. Bundle the ESM-only Pi
        // graph; leave Fastify at its existing workspace dependency boundary.
        ...(entry.startsWith('apps/app-service/') ? { external: ['fastify'] } : { packages: 'external' }),
        sourcemap: false, logLevel: 'info',
      });
    }
    if (process.platform === 'darwin') {
      for (const [source, output, build] of [
        ['apps/app-service/native/model-keychain.swift', join(service, 'model-keychain'), tools.buildKeychainHelper],
        ['apps/desktop/native/codex-presence.swift', join(desktop, 'codex-presence'), tools.buildPresenceHelper],
        ['apps/desktop/native/codex-window-bounds.swift', join(desktop, 'codex-window-bounds'), tools.buildWindowBoundsHelper],
        ['apps/desktop/native/video-fullscreen.swift', join(desktop, 'video-fullscreen'), tools.buildVideoFullscreenHelper],
      ]) {
        if (build) await build(root, output);
        else await buildMacHelper(root, source, output);
        await access(output);
      }
      await stageStartupVideo(root, join(desktop, 'startup'));
      await stageVideoUI(root, join(desktop, 'video'), tools.bundle);
      for (const name of ['task_reader.py', 'task_reader_worker.py']) {
        await copyFile(join(root, 'apps/runtime-bridge', name), join(desktop, 'runtime', name));
      }
      await copyFile(join(root, 'apps/runtime-bridge/task_events.py'), join(desktop, 'runtime', 'task_events.py'));
    }
    const branding = join(desktop, 'branding');
    await mkdir(branding);
    for (const icon of ['app-icon.png', 'petStatusTemplate.png', 'petStatusTemplate@2x.png']) {
      await copyFile(join(root, 'resources', 'branding', icon), join(branding, icon));
    }
    // Only the locally approved ignored still may be staged. It is not downloaded or distributed.
    const cover = join(root, '.local', 'pets', 'longmei', 'cover.png');
    if (process.platform === 'darwin' && (await lstat(cover).catch(() => undefined))?.isFile()) {
      const info = await lstat(cover);
      if (info.size <= 1024 * 1024) {
        const data = await readFile(cover);
        if (approvedLongmeiCovers.has(createHash('sha256').update(data).digest('hex'))) {
          await writeFile(join(branding, 'pet-cover.png'), data);
        }
      }
    }
    for (const name of ['worker.py', 'guardian.py']) {
      await copyFile(join(root, 'apps/runtime-bridge', name), join(desktop, 'runtime', name));
    }
    const speech = join(desktop, 'runtime', 'speech');
    await mkdir(speech);
    await copyFile(join(root, 'apps/runtime-bridge/bubble_speech_worker.py'), join(speech, 'bubble_speech_worker.py'));
    for (const name of ['stdio_service.py', 'mlx_backend.py', 'protocol.py', 'queueing.py', 'session.py', 'voice_draft_worker.py']) {
      await copyFile(join(root, 'apps/speech-runtime', name), join(speech, name));
    }
    for (const name of ['pet_sources.py', 'pet_library.py', 'pet_reference_lock.py']) {
      await copyFile(join(root, 'apps/pet-runtime/pets', name), join(desktop, 'runtime', name));
    }
    // Preserve exact upstream notices for the Pi code bundled into the service.
    await mkdir(join(service, 'licenses'));
    for (const name of ['pi-mit.txt', 'pi-schema-typebox.txt']) {
      await copyFile(join(root, 'licenses', name), join(service, 'licenses', name));
    }
    await tools.buildUI({
      configFile: join(root, 'apps/workspace-ui/vite.config.mjs'), root: join(root, 'apps/workspace-ui'),
      build: { outDir: join(desktop, 'ui'), emptyOutDir: true, sourcemap: false },
    });
    const uiAssets = join(desktop, 'ui', 'assets');
    await mkdir(uiAssets, { recursive: true });
    await copyFile(join(root, 'resources', 'branding', 'app-icon.svg'), join(uiAssets, 'app-icon.svg'));
    await copyFile(join(root, 'apps/desktop/src/microphone-worklet.js'), join(uiAssets, 'microphone-worklet.js'));
    for (const path of ['main.cjs', 'preload.cjs', 'ui/index.html', 'runtime/worker.py', 'runtime/guardian.py', 'runtime/pet_sources.py', 'runtime/pet_library.py', 'runtime/pet_reference_lock.py']) await access(join(desktop, path));
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
