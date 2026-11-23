import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import companionMedia from '../config/local-companion-media.json' with { type: 'json' };
import { stageVideoUI } from './stage-video-ui.mjs';
import { stageLocalCompanion } from './prepare-local-companion.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'apps/desktop/src/video-preview');
export async function buildPreview(out) {
  // Wait for all writers (including esbuild) before the caller can remove the temp directory.
  const results = await Promise.allSettled([
    build({ entryPoints: [join(source, 'main.ts')], bundle: true, outfile: join(out, 'main.cjs'),
      platform: 'node', target: 'node24', format: 'cjs', external: ['electron'] }),
    stageVideoUI(root, out),
    writeFile(join(out, 'package.json'), JSON.stringify({ name: 'pet-video-preview', private: true, main: 'main.cjs' })),
  ]);
  const error = results.find(result => result.status === 'rejected');
  if (error) throw error.reason;
}

export function companionCheckMessages(result) {
  if (!result.ready) return ['鲸鱼妹：待机 WebM 或封面缺失、权限不符合要求或校验失败；动作状态未检查。'];
  const total = Object.keys(companionMedia.actions).length;
  const messages = [`鲸鱼妹：固定待机 WebM 与封面已通过校验；动作 ${result.availableActions.length}/${total} 段可用。`];
  if (result.missingActions.length) {
    const labels = result.missingActions.map(id => companionMedia.actions[id]?.label ?? id);
    messages.push(`鲸鱼妹缺少或校验失败的可选动作：${labels.join('、')}`);
  }
  return messages;
}

async function runPreview(args) {
  const workspace = args[0] === '--workspace';
  if (workspace) args = args.slice(1);
  const command = workspace ? 'dev:desktop' : 'dev:pet-video-preview';
  const check = args.includes('--check');
  const launchCodex = args.includes('--launch-codex');
  const hmr = args.includes('--hmr');
  if (new Set(args).size !== args.length || args.some(arg => arg !== '--check' && !(workspace && (arg === '--launch-codex' || arg === '--hmr'))) ||
      (hmr && (check || launchCodex)) ||
      (process.platform !== 'darwin' && (!workspace || check || launchCodex))) {
    throw new Error(`此参数仅支持 macOS：pnpm run ${command} [--check]`);
  }
  let folder;
  let workspaceUI;
  let child;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    process.exitCode = 130;
    child?.kill('SIGTERM');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  async function runOwned(command, argv, timeout, env = process.env) {
    if (stopped) return 130;
    const processChild = child = spawn(command, argv, { stdio: 'inherit', cwd: root, env });
    const timer = timeout && setTimeout(() => processChild.kill('SIGTERM'), timeout);
    try {
      const [status] = await once(processChild, 'close');
      return status ?? 1;
    } finally {
      clearTimeout(timer);
      child = undefined;
    }
  }
  try {
    let mediaReady = false;
    let companionReady = false;
    let companionStage = { ready: false, availableActions: [], missingActions: [] };
    if (process.platform === 'darwin') {
      folder = await mkdtemp(join(tmpdir(), workspace ? 'pet-workspace-video-' : 'pet-video-preview-'));
      if (!workspace) await mkdir(join(folder, 'profile'));
      try {
        mediaReady = await runOwned('python3', ['-I', '-B', join(root, 'scripts/prepare-pet-video-preview.py'), folder], 20_000) === 0;
      } catch { /* Missing Python or local assets only blocks the video backend. */ }
      if (!stopped && workspace) {
        companionStage = await stageLocalCompanion(folder);
        companionReady = companionStage.ready;
      }
      if (stopped) return;
      if (!mediaReady && (!workspace || check)) throw new Error('未启动视频桌宠：准备本机素材失败。');
      if (!mediaReady) console.error('龙妹本机视频素材不可用；继续启动工作区。');
    }
    if (!workspace) await buildPreview(folder);
    else if (check) await stageVideoUI(root, join(folder, 'video'));
    else {
      const built = await runOwned(process.execPath, [join(root, 'scripts/build-cross-platform.mjs')]);
      if (stopped) return;
      if (built !== 0) throw new Error('未启动视频工作区：工作区构建失败。');
    }
    if (stopped) return;
    if (check) {
      const files = (await readdir(folder)).filter(file => file.endsWith('.webm'));
      const sizes = await Promise.all(files.map(async file => (await stat(join(folder, file))).size));
      if (!stopped) console.log(`离线准备完成：${sizes.length} 段原始 WebM，合计 ${sizes.reduce((a, b) => a + b)} 字节；未打开 Electron。`);
      if (!stopped && workspace) for (const message of companionCheckMessages(companionStage)) console.log(message);
      return;
    }
    if (hmr) {
      const { startWorkspaceUI } = await import('./workspace-ui-dev.mjs');
      if (stopped) return;
      workspaceUI = await startWorkspaceUI(root);
      if (stopped) return;
      console.log('工作区 Vite HMR 已就绪（仅本机）。');
    }
    const { default: electron } = await import('electron');
    const env = { ...process.env };
    delete env.PET_WORKSPACE_VIDEO_DIR;
    delete env.PET_WORKSPACE_UI_HMR;
    delete env.PET_HARNESS_NODE;
    if (workspace && process.platform === 'darwin') env.PET_HARNESS_NODE = process.execPath;
    if (workspaceUI) env.PET_WORKSPACE_UI_HMR = workspaceUI.activation;
    if (mediaReady || companionReady) env.PET_WORKSPACE_VIDEO_DIR = folder;
    const result = workspace
      ? await runOwned(electron, [join(root, 'apps/desktop'), ...(launchCodex ? ['--launch-codex'] : []), ...(hmr ? ['--workspace-ui-hmr'] : [])], undefined, env)
      : await runOwned(electron, [folder]);
    if (!stopped) process.exitCode = result;
  } finally {
    try {
      try { await workspaceUI?.close(); }
      finally { if (folder) await rm(folder, { recursive: true, force: true }); }
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runPreview(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
