import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = new URL('../apps/workspace-ui/', import.meta.url);
test('production keeps chat, model management, settings and secondary pages off the default entry graph', async () => {
  const out = await mkdtemp(join(tmpdir(), 'pet-ui-build-test-'));
  try {
    await build({ configFile: fileURLToPath(new URL('vite.config.mjs', root)), root: fileURLToPath(root),
      logLevel: 'silent', build: { outDir: out, manifest: true, emptyOutDir: true } });
    const manifest = JSON.parse(await readFile(join(out, '.vite/manifest.json'), 'utf8'));
    const initialFiles = new Set();
    function visit(key) {
      const { file, css = [], imports = [] } = manifest[key];
      if (initialFiles.has(file)) return;
      initialFiles.add(file);
      css.forEach(asset => initialFiles.add(asset));
      imports.forEach(visit);
    }
    visit('index.html');
    const asyncEntries = Object.values(manifest).filter(chunk => chunk.isDynamicEntry && !initialFiles.has(chunk.file));
    assert.equal(asyncEntries.length, 5);
    assert.ok(manifest['src/routes/chat-draft-preview.ts']?.isDynamicEntry);
    assert.ok(manifest['src/routes/pet-settings.ts']?.isDynamicEntry);
    assert.ok(asyncEntries.every(entry => entry.css?.length && entry.css.every(asset => !initialFiles.has(asset))));
    const bytes = await Promise.all([...initialFiles].map(async file => (await stat(join(out, file))).size));
    assert.ok(bytes.reduce((sum, size) => sum + size, 0) < 340_000, 'initial JS and CSS must remain below 340 KB');
    for (const file of initialFiles) assert.match(file, /^assets\/[a-zA-Z0-9_-]+\.(js|css)$/);
    const html = await readFile(join(out, 'index.html'), 'utf8');
    assert.match(html, /http-equiv="Content-Security-Policy"[^>]*connect-src &#39;none&#39;/);
    assert.doesNotMatch(html, /@vite\/client|@react-refresh|ws:\/\//);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
