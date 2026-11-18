import { execFile, type ExecFileOptionsWithBufferEncoding } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

export type CodexPresence = 'running' | 'not-detected' | 'unknown';
type Execute = (file: string, args: string[], options: ExecFileOptionsWithBufferEncoding) =>
  Promise<{ stdout: Buffer; stderr: Buffer }>;
const execute = promisify(execFile);
const running = Buffer.from('running\n');
const absent = Buffer.from('not-detected\n');

/** The directory comes from the trusted desktop bundle, never from a window or a request. */
export async function readCodexPresence(bundleDirectory: string, run: Execute = execute, signal?: AbortSignal): Promise<CodexPresence> {
  if (signal?.aborted) return 'unknown';
  try {
    const { stdout, stderr } = await run(join(bundleDirectory, 'codex-presence'), [], {
      encoding: 'buffer', shell: false, env: { LC_ALL: 'C' }, timeout: 1500, maxBuffer: 64, killSignal: 'SIGKILL', ...(signal ? { signal } : {}),
    });
    if (!signal?.aborted && stderr.length === 0) {
      if (stdout.equals(running)) return 'running';
      if (stdout.equals(absent)) return 'not-detected';
    }
  } catch { /* No diagnostics or paths enter the menu. */ }
  return 'unknown';
}
