import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';

export async function stageLiveUI(root, out, bundle = build) {
  const source = join(root, 'apps/desktop/src/live-stage');
  await mkdir(out, {recursive:true});
  await bundle({entryPoints:[join(source,'renderer.ts')],outfile:join(out,'stage.js'),bundle:true,platform:'browser',target:'es2023',format:'iife'});
  for (const name of ['index.html','stage.css']) await copyFile(join(source,name),join(out,name));
  const scenes = ['desk-room','rain-loft','cloud-terrace','meadow','forest','studio'];
  for (const id of scenes) for (const kind of ['room','desk','cover','preview']) {
    const name = `${id}-${kind}.webp`;
    await copyFile(join(source,'art',name),join(out,name));
  }
}
