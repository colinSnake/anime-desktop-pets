import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import media from '../config/local-companion-media.json' with { type: 'json' };

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const assets = join(root, '.local', 'pets', 'dafeiyu');
const coverHeader = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const coverWidth = 222, coverHeight = 278;
const validCover = (bytes, scale = 1) => bytes.length >= 33 && bytes.subarray(0, 16).equals(coverHeader) &&
  bytes.readUInt32BE(16) === coverWidth * scale && bytes.readUInt32BE(20) === coverHeight * scale && bytes[24] === 8 && bytes[25] === 6;
const approved = bytes => bytes.length === media.bytes && createHash('sha256').update(bytes).digest('hex') === media.sha256;

async function privateDirectory(path) {
  const info = await lstat(path);
  return info.isDirectory() && !(info.mode & 0o077) && info.uid === process.getuid?.();
}

async function regularFile(path, limit, privateFile = false) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > limit ||
        (privateFile && ((info.mode & 0o077) || info.uid !== process.getuid?.()))) throw new Error('invalid_local_asset');
    const bytes = Buffer.alloc(info.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== info.size) throw new Error('invalid_local_asset');
    return bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

export async function stageLocalCompanion(launchDirectory, assetDirectory = assets) {
  try {
    const videos = join(assetDirectory, 'videos');
    if (!await privateDirectory(assetDirectory) || !await privateDirectory(videos)) return false;
    const idle = await regularFile(join(videos, 'idle.webm'), media.bytes, true);
    if (!approved(idle)) return false;
    const cover = await regularFile(join(assetDirectory, 'cover.png'), 1024 * 1024, true);
    if (!validCover(cover) && !validCover(cover, 2)) return false;
    // Each launch owns its bounded copies. The renderer never reads the source checkout or asset library.
    const destination = join(launchDirectory, 'companion');
    await mkdir(destination, { mode: 0o700 });
    try {
      await writeFile(join(destination, 'idle.webm'), idle, { flag: 'wx', mode: 0o600 });
      await writeFile(join(destination, 'cover.png'), cover, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
    return true;
  } catch { return false; }
}

async function prepareCompanion(source) {
  // This does not execute anything from the source checkout or accept arbitrary media.
  const idle = await regularFile(join(resolve(source), media.source), media.bytes);
  if (!approved(idle)) throw new Error(`片段与固定版本 ${media.revision} 的 SHA-256 不符。`);
  for (const path of [dirname(dirname(assets)), dirname(assets)]) {
    await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(path);
    if (!info.isDirectory() || info.uid !== process.getuid?.()) throw new Error('本机素材目录不可用。');
  }
  const temporary = await mkdtemp(join(dirname(assets), '.dafeiyu-'));
  try {
    await mkdir(join(temporary, 'videos'), { mode: 0o700 });
    const path = join(temporary, 'videos', 'idle.webm');
    await writeFile(path, idle, { flag: 'wx', mode: 0o600 });
    const { stdout: cover } = await run('ffmpeg', ['-nostdin', '-v', 'error', '-c:v', 'libvpx-vp9', '-ss', '0.7', '-i', path,
      '-frames:v', '1', '-vf', `format=rgba,crop=${coverWidth}:${coverHeight}:210:56`, '-threads', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'],
    { encoding: 'buffer', timeout: 15_000, maxBuffer: 1024 * 1024 });
    if (!validCover(cover)) throw new Error('未能从本机素材生成透明封面。');
    await writeFile(join(temporary, 'cover.png'), cover, { flag: 'wx', mode: 0o600 });
    await rename(temporary, assets);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, ...extra] = process.argv.slice(2);
  try {
    if (process.platform !== 'darwin' || !source || extra.length) throw new Error('用法（macOS）：node scripts/prepare-local-companion.mjs <dsh-pet checkout>');
    await prepareCompanion(source);
    console.log('大肥鱼本机素材已就绪：.local/pets/dafeiyu 下的 cover.png 与 videos/idle.webm。未登记实例、未启动桌宠。');
  } catch (error) {
    console.error('准备大肥鱼失败：' + (error.code === 'ENOTEMPTY' || error.code === 'EEXIST' ? '本机素材已存在，未覆盖。' : error.message));
    process.exitCode = 1;
  }
}
