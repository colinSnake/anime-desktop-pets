/** Ship only the existing local development asset; a clean checkout can omit it. */
import { constants, createWriteStream } from 'node:fs';
import { copyFile, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

export async function stageStartupVideo(root, destination) {
  await mkdir(destination);
  for (const name of ['index.html', 'player.css', 'player.js']) {
    await copyFile(join(root, 'apps', 'desktop', 'startup', name), join(destination, name));
  }
  let source;
  try {
    source = await open(join(root, 'resources', 'media', 'startup.mp4'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return;
    throw error;
  }
  try {
    const stat = await source.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > 128 * 1024 * 1024) return;
    await pipeline(source.createReadStream({ end: stat.size - 1 }), createWriteStream(join(destination, 'startup.mp4'), { flags: 'wx', mode: 0o600 }));
    await copyFile(join(root, 'licenses', 'startup-media.md'), join(destination, 'startup-media-license.md'));
  } finally { await source.close(); }
}
