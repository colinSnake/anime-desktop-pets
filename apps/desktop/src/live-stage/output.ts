import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { LiveStageClock } from './clock.ts';

const policy = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";
export type StageAsset = { type: string; bytes: Buffer };
export type StageOutput = { url: string; close(): Promise<void> };
function range(header: string, size: number): [number, number] | undefined {
  const m = /^bytes=(\d{0,10})-(\d{0,10})$/.exec(header);
  if (!m || (!m[1] && !m[2])) return;
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
  if (start <= end && start < size) return [start, end];
}
export async function openStageOutput(clock: LiveStageClock, assets: ReadonlyMap<string, StageAsset>): Promise<StageOutput> {
  const path = `/stage/${randomBytes(24).toString('hex')}/`;
  let host = '', retiring = false;
  const sockets = new Set<Socket>();
  const server = createServer({ maxHeaderSize: 8192, keepAliveTimeout: 1500, headersTimeout: 3000, requestTimeout: 5000 }, (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', policy);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cross-origin-resource-policy', 'same-origin');
    if (retiring) { res.writeHead(410).end(); return; }
    if (req.headers.host !== host || req.headers.origin !== undefined || req.headers['sec-fetch-site'] === 'cross-site') { res.writeHead(403).end(); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }).end(); return; }
    const prefix = req.url;
    if (!prefix?.startsWith(path)) { res.writeHead(404).end(); return; }
    const name = prefix.slice(path.length);
    const voiceId = /^voice-([1-9]\d{0,15})\.wav$/.exec(name)?.[1];
    const voice = voiceId && clock.voiceFor(Number(voiceId));
    const asset = voiceId ? (voice ? {type:'audio/wav', bytes:voice} : undefined) : name === 'state.json' ? { type: 'application/json; charset=utf-8', bytes: Buffer.from(JSON.stringify(clock.snapshot())) } : assets.get(name || 'index.html');
    if (!asset) { res.writeHead(404).end(); return; }
    const { bytes, type } = asset;
    const ranged = type === 'video/webm' || type === 'audio/wav';
    const requested = ranged ? req.headers.range : undefined;
    const slice = requested && range(requested, bytes.length);
    if (requested && !slice) { res.writeHead(416, { 'content-range': `bytes */${bytes.length}` }).end(); return; }
    const headers: Record<string, string | number> = { 'content-type': type, 'content-length': bytes.length };
    if (ranged) headers['accept-ranges'] = 'bytes';
    if (slice) { headers['content-range'] = `bytes ${slice[0]}-${slice[1]}/${bytes.length}`; headers['content-length'] = slice[1] - slice[0] + 1; }
    res.writeHead(slice ? 206 : 200, headers).end(req.method === 'HEAD' ? undefined : slice ? bytes.subarray(slice[0], slice[1] + 1) : bytes);
  });
  server.maxConnections = 20;
  server.on('connection', sock => { sockets.add(sock); sock.once('close', () => sockets.delete(sock)); sock.setTimeout(7000, () => sock.destroy()); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({host:'127.0.0.1',port:0,exclusive:true}, () => { server.removeListener('error', reject); host = `127.0.0.1:${(server.address() as AddressInfo).port}`; resolve(); });
  });
  let closing: Promise<void> | undefined;
  return { url: `http://${host}${path}`, close() {
    if (!closing) {
      retiring = true;
      closing = new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); for (const s of sockets) s.destroy(); });
    }
    return closing;
  } };
}
