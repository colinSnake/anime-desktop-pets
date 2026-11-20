import { spawn } from 'node:child_process';
import { delimiter, isAbsolute, join } from 'node:path';
import { QuotaSlot } from '../../../app-service/src/pet-quota';
import { parsePreviewQuotaResult } from './quota-result';
import type { PreviewQuotaState } from './bridge';

function readPreviewQuota(folder: string, signal: AbortSignal): Promise<unknown> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(undefined); return; }
    const path = (process.env.PATH ?? '/usr/bin:/bin').split(delimiter).filter(isAbsolute).join(delimiter) || '/usr/bin:/bin';
    const child = spawn('python3', ['-I', '-B', join(folder, 'quota_source.py')], {
      env: { ...process.env, PATH: path }, cwd: folder, detached: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    let bytes = 0;
    const chunks: Buffer[] = [];
    const stop = () => {
      // The session group belongs solely to this helper and its own CLI, never a desktop Codex process.
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }
    };
    signal.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4096) stop();
      else chunks.push(chunk);
    });
    child.on('error', stop); // Settle on close, after the owned pipes have been cleaned up.
    child.once('close', status => {
      signal.removeEventListener('abort', stop);
      if (status === 0 && !signal.aborted && bytes <= 4096) {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); return; } catch { /* invalid output */ }
      }
      resolve(undefined);
    });
  });
}

export function createPreviewQuotaSource(folder: string,
  read: (signal: AbortSignal) => Promise<unknown> = signal => readPreviewQuota(folder, signal)) {
  let pending: Promise<unknown> | undefined;
  const slot = new QuotaSlot(async signal => {
    const load = pending = read(signal);
    try { return await load; } finally { if (pending === load) pending = undefined; }
  }, parsePreviewQuotaResult);
  return { request: slot.request.bind(slot), async drain() { await pending?.catch(() => {}); } };
}
export type PreviewQuotaSource = ReturnType<typeof createPreviewQuotaSource>;

export function createPreviewQuota(source: PreviewQuotaSource, publish: (state: PreviewQuotaState) => void) {
  let open = false;
  let cancel: (() => void) | undefined;
  function request() {
    if (cancel) return;
    open = true;
    publish({ kind: 'loading' });
    // A busy response may be synchronous while a cancelled source still holds the slot.
    let settled = false;
    const stop = source.request(result => {
      settled = true;
      cancel = undefined;
      if (open) publish({ ...result, queriedAt: Date.now() });
    });
    if (!settled) cancel = stop;
  }
  function close(notify = true) {
    if (!open) return;
    open = false;
    cancel?.();
    cancel = undefined;
    if (notify) publish({ kind: 'closed' });
  }
  return { request, close, refresh() { if (open) request(); } };
}
