import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';

export const COVER_URL = 'pet-app://workspace/covers/local.development.longmei/0.0.0-dev.png';
type CoverOptions = { assets: string; workerPath: string; python?: string };
type Decode = (options: CoverOptions, signal: AbortSignal) => Promise<Buffer>;
const maximum = 1024 * 1024;

/** Fixed private decoder; no shell, renderer input, Qt or inherited account variables. */
const decode: Decode = (options, signal) => new Promise((resolve, reject) => {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  let output: Buffer | undefined;
  let failed = false;
  const child = execFile(options.python ?? (process.platform === 'win32' ? 'python' : 'python3'),
    ['-I', '-B', options.workerPath],
    { env, encoding: 'buffer', timeout: 3000, maxBuffer: maximum, killSignal: 'SIGKILL', signal, windowsHide: true },
    (error, stdout) => { failed = !!error; output = error ? undefined : stdout; });
  // Abort's callback can precede process exit. Do not confirm cleanup until close.
  child.once('close', () => failed || !output ? reject(new Error('cover_unavailable')) : resolve(output));
  child.stdin?.on('error', () => {});
  child.stdin?.end(JSON.stringify({ version: 1, assets: options.assets }));
});

function validPng(data: Buffer): boolean {
  return data.length >= 33 && data.length <= maximum &&
    data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) &&
    data.readUInt32BE(8) === 13 && data.toString('ascii',12,16) === 'IHDR' &&
    [data.readUInt32BE(16),data.readUInt32BE(20)].every(n => n > 0 && n <= 512);
}

/** One approved development package, one shared in-memory result (including misses). */
export class PetCoverProvider {
  private readonly abort = new AbortController();
  private pending?: Promise<Buffer | undefined>;
  private closed = false;
  constructor(private options?: CoverOptions, private read: Decode = decode) {}

  async response(url: string, method: string): Promise<Response | undefined> {
    if (url !== COVER_URL || method !== 'GET') return undefined;
    const options = this.options;
    if (this.closed || !options || ![options.assets, options.workerPath].every(path =>
      path.length <= 1024 && isAbsolute(path) && !path.includes('\0'))) return new Response('', {status:404});
    this.pending ??= this.read(options, this.abort.signal).then(data => validPng(data) ? data : undefined).catch(() => undefined);
    const data = await this.pending;
    if (this.closed || !data) return new Response('', {status:404});
    return new Response(new Uint8Array(data), { headers: {
      'content-type': 'image/png', 'x-content-type-options': 'nosniff',
      'cache-control': 'no-store', 'content-security-policy': "default-src 'none'",
    } });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abort.abort();
    await this.pending;
  }
}
