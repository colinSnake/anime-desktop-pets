import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { acceptedChatText, validChatReplyText } from '../../../../packages/contracts/src/online-chat.ts';
import { shape } from '../../../../packages/contracts/src/pets.ts';
import { ModelError } from '../models/errors.ts';
import { HarnessCleanupError, type TextChatRuntime } from './text-chat-runtime.ts';

const version = '0.2.2-rc.5';
const model = 'pet-harness';
const keyName = 'PET_HARNESS_TURN_TOKEN';

function storeFor(path: string): string {
  for (let cursor = dirname(path); cursor !== dirname(cursor); cursor = dirname(cursor)) {
    if (cursor.endsWith('/node_modules/.pnpm')) return cursor;
  }
  throw new ModelError('closed');
}

function validEnvelope(body: unknown, text: string, workspace: string) {
  if (!shape(body, ['model', 'messages', 'stream', 'stream_options', 'store', 'max_completion_tokens']) ||
      body.model !== model || body.stream !== true || body.store !== false || body.max_completion_tokens !== 96 ||
      (body.stream_options !== undefined && (!shape(body.stream_options, ['include_usage']) || body.stream_options.include_usage !== true))) return false;
  const rows = [
    { role: 'system', content: 'You are a helpful software engineer assistant.' },
    { role: 'user', content: text },
    { role: 'user', content: `<system-reminder>\nThe following information describes your current session:\n\nCurrent working directory: "${workspace}".\n</system-reminder>` },
  ];
  const { messages } = body;
  return Array.isArray(messages) && messages.length === rows.length && rows.every((expected, i) => {
    const row: unknown = messages[i];
    return shape(row, ['role', 'content']) && row.role === expected.role && row.content === expected.content;
  });
}

function respond(res: ServerResponse, text: string) {
  const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({
    id: 'pet-harness-turn', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`;
  res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
  res.end(chunk({ role: 'assistant', content: text }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
}

async function groupGone(pid: number) {
  const deadline = performance.now() + 1500;
  do {
    try { process.kill(-pid, 0); }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    await delay(25);
  } while (performance.now() < deadline);
  return false;
}

/** One isolated SDK child per frozen turn. No saved model metadata crosses this adapter. */
export function createHarnessRuntime({ worker, executable = process.execPath, privateRoots = [] }: {
  worker: string; executable?: string; privateRoots?: string[];
}): TextChatRuntime {
  let cleanupUnconfirmed = false;
  return async (text, complete, signal) => {
    if (cleanupUnconfirmed || !worker || !executable || process.platform !== 'darwin' || !acceptedChatText(text)) throw new ModelError('closed');
    signal.throwIfAborted();
    const script = await realpath(worker), node = await realpath(executable);
    const require = createRequire(script);
    const sdk = await realpath(require.resolve('@deepseek-ai/dsh-sdk-client/package.json'));
    // Match the CLI resolution the SDK will use, not a separate service import.
    const [cli, provider] = await Promise.all([
      realpath(createRequire(sdk).resolve('@deepseek-ai/dsh/package.json')),
      realpath(require.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json')),
    ]);
    const store = storeFor(sdk);
    if ([sdk, cli, provider].some(path => storeFor(path) !== store || require(path).version !== version)) throw new ModelError('closed');
    // The pnpm link farm is needed for the SDK import and the DSH plugin loader.
    // Do not grant reads to the checkout, account home, or the service-data directory.
    const links = join(dirname(dirname(store)), 'apps', 'app-service', 'node_modules');
    const temporary = await mkdtemp(join(await realpath(tmpdir()), 'pet-harness-'));
    const capability = randomBytes(24).toString('hex');
    let port = 0, admitted = false, stopped = false, removable = true;
    const server = createServer({ maxHeaderSize: 4096, requestTimeout: 5000, headersTimeout: 4000 }, async (req, res) => {
      const reject = (code: number) => { req.resume(); res.writeHead(code, { connection: 'close' }).end(); };
      if (stopped || signal.aborted || req.method !== 'POST' || req.url !== '/v1/chat/completions' ||
          req.headers.authorization !== `Bearer ${capability}` || req.headers.host !== `127.0.0.1:${port}` ||
          req.headers.origin !== undefined || req.headers['content-type'] !== 'application/json') return reject(403);
      try {
        let bytes = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 32 * 1024) { res.destroy(); return; }
          chunks.push(chunk);
        }
        if (stopped || signal.aborted || res.destroyed || admitted) return reject(409);
        if (!validEnvelope(JSON.parse(Buffer.concat(chunks).toString('utf8')), text, join(temporary, 'workspace'))) return reject(422);
        admitted = true;
        const reply = await complete(text);
        if (!stopped && !signal.aborted && !res.destroyed && validChatReplyText(reply)) respond(res, reply);
        else res.destroy();
      } catch {
        if (!res.destroyed && !res.headersSent) reject(502);
        else res.destroy();
      }
    });
    server.maxConnections = 4;
    server.timeout = 64_000;
    try {
      signal.throwIfAborted();
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new ModelError('closed');
      port = address.port;
      signal.throwIfAborted();
      const q = JSON.stringify;
      const paths = [temporary, store, links];
      const denied = ['/Users', '/Volumes', '/private/var/folders', '/private/tmp', '/private/var/root',
        await realpath(userInfo().homedir), dirname(dirname(store)), ...privateRoots];
      const policy = `(version 1) (allow default) (deny network*)
        (allow network-outbound (remote ip "localhost:${port}"))
        (deny file-read-data (subpath ${denied.map(path => q(path)).join(' ')}))
        (allow file-read-data (literal ${[node, script, '/dev/null', '/dev/urandom', '/dev/random'].map(path => q(path)).join(' ')})
          (subpath ${paths.map(path => q(path)).join(' ')}))
        (deny file-write*) (allow file-write* (subpath ${q(temporary)}))
        (deny process-exec) (allow process-exec (literal ${q(node)}))`;
      const child = spawn('/usr/bin/sandbox-exec', ['-p', policy, node, script, String(port)], {
        cwd: temporary, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { PATH: '/usr/bin:/bin', HOME: temporary, TMPDIR: temporary, [keyName]: capability },
      });
      let terminal: string | undefined, frames = 0;
      let kill: ReturnType<typeof setTimeout> | undefined, retire: ReturnType<typeof setTimeout> | undefined;
      let unconfirmed!: () => void;
      const watchdog = new Promise<undefined>(resolve => { unconfirmed = () => resolve(undefined); });
      const stop = () => {
        if (stopped) return;
        stopped = true;
        server.closeAllConnections();
        if (child.connected) child.disconnect();
        kill ??= setTimeout(() => {
          if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 3000);
        retire ??= setTimeout(unconfirmed, 4500);
      };
      // Node does not always emit ChildProcess 'close' after our side explicitly
      // closes IPC. Confirm native exit and channel retirement independently.
      const exited = new Promise<number | null>(resolve => {
        child.once('exit', resolve);
        child.once('error', () => { if (!child.pid) resolve(null); });
      });
      const disconnected = new Promise<void>(resolve => {
        child.once('disconnect', resolve);
        child.once('error', () => { if (!child.pid) resolve(); });
      });
      child.on('error', stop);
      child.on('message', frame => {
        if (stopped || ++frames !== 1 || !shape(frame, ['text']) || !validChatReplyText(frame.text)) stop();
        else terminal = frame.text;
      });
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
      else child.send({ text }, error => { if (error) stop(); });
      const evidence = await Promise.race([Promise.all([exited, disconnected]), watchdog]);
      signal.removeEventListener('abort', stop);
      // A later kill/send callback will not restart the cancellation watchdog.
      if (kill) clearTimeout(kill);
      if (retire) clearTimeout(retire);
      stopped = true;
      removable = !!evidence && (!child.pid || await groupGone(child.pid));
      if (!removable) { cleanupUnconfirmed = true; throw new HarnessCleanupError(); }
      signal.throwIfAborted();
      if (evidence?.[0] !== 0 || frames !== 1 || !terminal || !admitted) throw new ModelError(admitted ? 'upstream_unavailable' : 'closed');
      return terminal;
    } finally {
      stopped = true;
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      if (removable) await rm(temporary, { recursive: true, force: true });
    }
  };
}
