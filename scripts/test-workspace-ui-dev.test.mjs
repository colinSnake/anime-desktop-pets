import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { workspaceDevConfig, workspaceDevResponse } from '../apps/desktop/src/workspace-ui-hmr.ts';
import { startWorkspaceUI } from './workspace-ui-dev.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const source = join(repo, 'apps/workspace-ui');

test('Vite pushes CSS and React updates through the fixed workspace origin without a restart', { timeout: 20_000 }, async () => {
  await mkdir(join(repo, '.local'), { recursive: true });
  const fixture = await mkdtemp(join(repo, '.local', 'workspace-hmr-test-'));
  let server;
  let socket;
  try {
    const ui = join(fixture, 'apps/workspace-ui');
    await mkdir(join(ui, 'src'), { recursive: true });
    await mkdir(join(ui, 'node_modules'));
    await writeFile(join(ui, 'vite.config.mjs'), `export { default } from ${JSON.stringify(relative(ui, join(source, 'vite.config.mjs')).split(sep).join('/'))};`);
    await cp(join(source, 'index.html'), join(ui, 'index.html'));
    for (const name of ['react', 'react-dom']) await symlink(join(source, 'node_modules', name), join(ui, 'node_modules', name), 'junction');
    await writeFile(join(ui, 'src/main.tsx'), "import './style.css';\nimport './Panel.tsx';");
    const panel = message => `export function Panel() { return <main>${message}</main>; }`;
    await writeFile(join(ui, 'src/Panel.tsx'), panel('Before'));
    await writeFile(join(ui, 'src/style.css'), 'main { color: red; }');

    server = await startWorkspaceUI(fixture);
    const config = workspaceDevConfig(true, true, server.activation);
    const get = path => workspaceDevResponse(config, new Request(`pet-app://workspace${path}`));
    const text = async path => {
      const res = await get(path);
      assert.equal(res.status, 200, path);
      return res.text();
    };
    assert.equal((await fetch(`http://127.0.0.1:${config.port}/index.html`)).status, 404);
    const document = await get('/index.html');
    const html = await document.text();
    const nonce = document.headers.get('content-security-policy').match(/'nonce-([0-9a-f]{32})'/)[1];
    assert.match(html, new RegExp(`src="/@vite/client" nonce="${nonce}"`));
    assert.match(html, new RegExp(`nonce="${nonce}">[^<]+/@react-refresh`));
    assert.match(await text('/src/main.tsx'), /import "\/src\/style.css"/);
    assert.match(await text('/src/style.css'), /color: red/);
    assert.match(await text('/src/Panel.tsx'), /import\.meta\.hot\.accept/);

    const client = await text('/@vite/client');
    const token = client.match(/const wsToken = "([^"]+)";/)[1];
    const url = `ws://127.0.0.1:${config.port}/_pet_workspace_hmr?token=${encodeURIComponent(token)}`;
    const rejected = new WebSocket(url, { protocols: ['vite-hmr'], headers: { Origin: 'https://example.invalid' } });
    const [denied] = await once(rejected, 'close', { signal: AbortSignal.timeout(3000) });
    assert.notEqual(denied.code, 1000);
    const connect = new WebSocket(url, { protocols: ['vite-hmr'], headers: { Origin: 'pet-app://workspace' } });
    socket = connect;
    const events = [];
    connect.addEventListener('message', event => events.push(JSON.parse(event.data)));
    await once(connect, 'open', { signal: AbortSignal.timeout(3000) });
    for (const [path, contents, type, updated] of [
      ['style.css', 'main { color: blue; }', 'js-update', /color: blue/],
      ['Panel.tsx', panel('After'), 'js-update', /After/],
    ]) {
      const next = once(connect, 'message', { signal: AbortSignal.timeout(5000) });
      await writeFile(join(ui, 'src', path), contents);
      // A Vite connection/dependency optimizer notification can precede this update.
      await next;
      while (!events.some(event => event.type === 'update' && event.updates.some(update => update.type === type && update.path === `/src/${path}`))) {
        await once(connect, 'message', { signal: AbortSignal.timeout(5000) });
      }
      assert.match(await text(`/src/${path}?t=${Date.now()}`), updated);
    }
    const reloaded = new Promise((resolve, reject) => {
      const timeout = AbortSignal.timeout(5000);
      timeout.addEventListener('abort', () => reject(timeout.reason), { once: true });
      connect.addEventListener('message', event => {
        if (JSON.parse(event.data).type === 'full-reload') resolve();
      }, { signal: timeout });
    });
    await writeFile(join(ui, 'index.html'), '<!doctype html><head><title>页面重载</title></head>');
    await reloaded;
    assert.equal(connect.readyState, WebSocket.OPEN);
    await server.close();
    server = undefined;
    await assert.rejects(fetch(`http://127.0.0.1:${config.port}/index.html`));
  } finally {
    socket?.close();
    await server?.close();
    await rm(fixture, { recursive: true, force: true });
  }
});
