import { randomBytes } from 'node:crypto';
import { CONTENT_SECURITY_POLICY } from './security.ts';

const loopback = '127.0.0.1';
const nonceMarker = '__PET_WORKSPACE_DEV_NONCE__';
const servePaths = /^\/(?:@vite\/(?:client|env)$|@react-refresh$|(?:src|@id|@fs|node_modules)\/)/;

type WorkspaceDevConfig = { port: number; token: string; proof: string };
export function workspaceDevConfig(defaultApp: boolean, requested: boolean, activation?: string): WorkspaceDevConfig | undefined {
  if (!defaultApp || !requested) return;
  const parts = /^(\d{1,5}):([a-f\d]{64}):([a-f\d]{64})$/.exec(activation ?? '');
  if (!parts || !parts[2] || !parts[3] || Number(parts[1]) < 1 || Number(parts[1]) > 65535) throw new Error('invalid_workspace_hmr_activation');
  return { port: Number(parts[1]), token: parts[2], proof: parts[3] };
}

/** Keep the trusted document at pet-app://workspace. Never grant an HTTP page the preload bridge. */
export async function workspaceDevResponse(config: WorkspaceDevConfig, request: Request, requestModule = fetch): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.protocol !== 'pet-app:' || url.host !== 'workspace' || url.username || url.password || url.hash ||
      (url.pathname !== '/index.html' && !servePaths.test(url.pathname))) return new Response(null, { status: 404 });
  const target = new URL(`http://${loopback}:${config.port}`);
  // Assign components rather than resolving an untrusted relative URL against the loopback origin.
  target.pathname = url.pathname;
  target.search = url.search;
  try {
    const upstream = await requestModule(target, { redirect: 'error', signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
      headers: { 'x-pet-dev-token': config.token } });
    if (upstream.headers.get('x-pet-dev-proof') !== config.proof) {
      await upstream.body?.cancel();
      return new Response(null, { status: 503 });
    }
    const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
    const headers = new Headers({ 'content-type': contentType, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
    const nonce = randomBytes(16).toString('hex');
    headers.set('content-security-policy', CONTENT_SECURITY_POLICY
      .replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`)
      .replace("style-src 'self'", `style-src 'self' 'nonce-${nonce}'`)
      .replace("connect-src 'none'", `connect-src ws://${loopback}:${config.port}`));
    const body = url.pathname === '/index.html' && upstream.ok && contentType.startsWith('text/html')
      ? (await upstream.text()).replaceAll(nonceMarker, nonce) : upstream.body;
    return new Response(body, { status: upstream.status, headers });
  } catch {
    return new Response(null, { status: 503 });
  }
}
