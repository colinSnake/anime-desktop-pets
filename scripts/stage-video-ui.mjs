import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';

/** The workspace bundles only its local video surface, including the fixed main-only quota helper; no account data is bundled. */
export async function stageVideoUI(root, out, bundle = build) {
  const source = join(root, 'apps/desktop/src/video-preview');
  await mkdir(out, { recursive: true });
  await bundle({ entryPoints: [join(source, 'preload.ts')], outfile: join(out, 'preload.cjs'), bundle: true,
    platform: 'node', target: 'node24', format: 'cjs', external: ['electron'] });
  await bundle({ entryPoints: [join(source, 'renderer.ts')], outfile: join(out, 'renderer.js'), bundle: true,
    platform: 'browser', target: 'es2023', format: 'iife' });
  for (const name of ['index.html', 'style.css', 'quota_source.py']) await copyFile(join(source, name), join(out, name));
}
