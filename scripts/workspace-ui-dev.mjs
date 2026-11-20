import { randomBytes } from 'node:crypto';
import { createServer as createHTTPServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { createServer as createViteServer } from 'vite';

const host = '127.0.0.1';
export async function startWorkspaceUI(root) {
  const ui = join(root, 'apps/workspace-ui');
  const token = randomBytes(32).toString('hex');
  const proof = randomBytes(32).toString('hex');
  const upgrades = createHTTPServer(); // No listener; only receives validated upgrades from the owned socket.
  let vite;
  const server = createHTTPServer((req, res) => {
    if (req.headers.host !== `${host}:${server.address()?.port}` || req.headers['x-pet-dev-token'] !== token || req.method !== 'GET') {
      res.writeHead(404).end();
      return;
    }
    // Authentication headers are never part of the renderer response or Vite's request context.
    delete req.headers['x-pet-dev-token'];
    res.setHeader('x-pet-dev-proof', proof);
    if (vite) vite.middlewares(req, res);
    else res.writeHead(503).end();
  });
  const close = async () => {
    const stopped = new Promise((resolve, reject) => server.close(error => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
      else resolve();
    }));
    server.closeAllConnections();
    await Promise.all([stopped, vite?.close()]);
  };
  try {
    server.listen(0, host);
    await once(server, 'listening');
    const { port } = server.address();
    server.on('upgrade', (req, socket, head) => {
      if (req.headers.host !== `${host}:${port}` || req.headers.origin !== 'pet-app://workspace' ||
          !req.url?.startsWith('/_pet_workspace_hmr?token=') || req.headers['sec-websocket-protocol'] !== 'vite-hmr') socket.destroy();
      else upgrades.emit('upgrade', req, socket, head);
    });
    vite = await createViteServer({ root: ui, configFile: join(ui, 'vite.config.mjs'),
      appType: 'mpa', html: { cspNonce: '__PET_WORKSPACE_DEV_NONCE__' },
      server: { middlewareMode: true, host, port, cors: false, forwardConsole: false, preTransformRequests: false,
        ws: { server: upgrades, host, port, clientPort: port, protocol: 'ws', path: '/_pet_workspace_hmr' },
        fs: { strict: true, allow: [ui, join(root, 'node_modules'), join(root, 'packages/contracts/src')] } } });
    return { activation: `${port}:${token}:${proof}`, close };
  } catch (error) {
    await close();
    throw error;
  }
}
