import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { session } from 'electron';
import companionMedia from '../../../config/local-companion-media.json';
import { dafeiyu, longmei, samePetPackage } from '../../../packages/contracts/src/built-in-pets.ts';
import { readVideoFullscreen, VideoFullscreenObserver } from './video-fullscreen.ts';
import { parseVideoLines } from './video-preview/captions.ts';
import { companionClips, mediaFiles, type CompanionClip } from './video-preview/playback.ts';
import { maxMediaBytes, previewResponse, previewScheme, readCaptionFont } from './video-preview/media.ts';
import { companionHost } from './video-preview/video-role.ts';
import { createVideoWindow } from './video-preview/video-window.ts';
import { createPreviewQuotaSource } from './video-preview/quota.ts';
import { WorkspaceVideoHost } from './workspace-video-host.ts';

async function privateDirectory(path: string) {
  const directory = await lstat(path);
  return directory.isDirectory() && !(directory.mode & 0o077) && directory.uid === process.getuid?.();
}

async function validateLongmei(media: string) {
  let bytes = 0;
  for (const clip of mediaFiles) {
    const asset = await lstat(join(media, `${clip}.webm`));
    if (!asset.isFile() || asset.size <= 4 || asset.size > maxMediaBytes) return;
    bytes += asset.size;
  }
  if (bytes > 256 * 1024 * 1024) return;
  const captionFile = join(media, 'captions.json');
  const info = await lstat(captionFile);
  if (!info.isFile() || info.size > 12 * 1024) return;
  return parseVideoLines(JSON.parse(await readFile(captionFile, 'utf8')));
}

async function validateCompanion(media: string) {
  if (!await privateDirectory(media)) return false;
  const readPinned = async (name: string, pin: { bytes: number; sha256: string }) => {
    const file = await open(join(media, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
    const info = await file.stat();
    if (!info.isFile() || info.size !== pin.bytes || (info.mode & 0o077) || info.uid !== process.getuid?.()) return false;
    const data = Buffer.alloc(pin.bytes + 1);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    return bytesRead === pin.bytes && createHash('sha256').update(data.subarray(0, bytesRead)).digest('hex') === pin.sha256;
    } finally { await file.close(); }
  };
  if (!await readPinned('idle.webm', companionMedia)) return false;
  const available: CompanionClip[] = [];
  for (const clip of companionClips) {
    if (await readPinned(`${clip}.webm`, companionMedia.actions[clip]).catch(() => false)) available.push(clip);
  }
  return available;
}

/** Only called by the explicit development launch path, before the service is started. */
export async function prepareWorkspaceVideo(bundle: string, media: string) {
  if (process.platform !== 'darwin' || !isAbsolute(media) || !await privateDirectory(media)) throw new Error('workspace_video_unavailable');
  for (const name of ['index.html', 'style.css', 'renderer.js', 'preload.cjs', 'quota_source.py']) {
    if (!(await lstat(join(bundle, name))).isFile()) throw new Error('workspace_video_unavailable');
  }
  const companionDirectory = join(media, 'companion');
  const [lines, companionClipsReady] = await Promise.all([
    validateLongmei(media).catch(() => undefined), validateCompanion(companionDirectory).catch(() => false),
  ]);
  const companion = Array.isArray(companionClipsReady);
  if (!lines && !companion) throw new Error('workspace_video_unavailable');
  const sessionFor = (name: string) => {
    const local = session.fromPartition(name, { cache: false });
    local.setPermissionCheckHandler(() => false);
    local.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    return local;
  };
  const dragonSession = lines ? sessionFor('pet-workspace-video') : undefined;
  const companionSession = companion ? sessionFor('pet-workspace-video-companion') : undefined;
  const font = await readCaptionFont(media);
  dragonSession?.protocol.handle(previewScheme, request => previewResponse(bundle, request, media, font));
  companionSession?.protocol.handle(previewScheme, request => previewResponse(bundle, request, companionDirectory, font, companionHost));
  const fullscreen = new VideoFullscreenObserver(signal => readVideoFullscreen(dirname(bundle), signal));
  const quotaSource = createPreviewQuotaSource(bundle);
  const host = new WorkspaceVideoHost((input, ended, slot, onDrop, onCue, onMenu) => {
    const companionRole = samePetPackage(input.package, dafeiyu);
    const localSession = companionRole ? companionSession : samePetPackage(input.package, longmei) ? dragonSession : undefined;
    if (!localSession) throw new Error('workspace_video_package_unavailable');
    return createVideoWindow({ folder: bundle, localSession, preferences: input.preferences, companionRole, companionClips: companionRole ? companionClipsReady as CompanionClip[] : undefined,
      quotaSource, slot, ended, onDrop, onCue, onMenu, lines: companionRole ? undefined : lines ?? undefined,
      observeFullscreen: listener => fullscreen.subscribe(listener),
    });
  }, undefined, quotaSource.drain);
  return { host, longmeiReady: !!lines, companionReady: companion, companionClips: companion ? companionClipsReady as CompanionClip[] : [],
    companionCover: companion ? join(companionDirectory, 'cover.png') : undefined };
}
