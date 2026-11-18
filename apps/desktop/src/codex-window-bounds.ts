import { execFile, type ExecFileOptionsWithBufferEncoding } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { StartupBounds } from './startup-alignment.ts';

type Execute = (file: string, args: string[], options: ExecFileOptionsWithBufferEncoding) =>
  Promise<{ stdout: Buffer; stderr: Buffer }>;
const execute = promisify(execFile);
const MAX_OUTPUT = 64;

/** A separate, fixed query only for the active startup animation. No window data leaves main. */
export async function readCodexWindowBounds(
  bundleDirectory: string, signal: AbortSignal, run: Execute = execute,
): Promise<StartupBounds | undefined> {
  if (signal.aborted) return;
  try {
    const { stdout, stderr } = await run(join(bundleDirectory, 'codex-window-bounds'), [], {
      encoding: 'buffer', shell: false, env: { LC_ALL: 'C' }, timeout: 750,
      maxBuffer: MAX_OUTPUT, killSignal: 'SIGKILL', signal,
    });
    if (signal.aborted || stderr.length || stdout.length > MAX_OUTPUT) return;
    const text = stdout.toString('utf8');
    const match = /^v1 (-?\d{1,6}) (-?\d{1,6}) (\d{1,5}) (\d{1,5})\n/.exec(text);
    if (!match || match[0] !== text) return;
    const x = Number(match[1]), y = Number(match[2]), width = Number(match[3]), height = Number(match[4]);
    if (Math.abs(x) > 131072 || Math.abs(y) > 131072 || width < 320 || height < 200 || width > 16384 || height > 16384) return;
    return { x, y, width, height };
  } catch { /* Missing, timed-out, or inaccessible geometry leaves the video centered. */ }
}
