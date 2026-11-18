import { execFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';
import type { CodexPresence } from './codex-presence.ts';

export type LaunchResult = 'accepted' | 'failed' | 'unconfirmed';
export type StartupPlayback = { done: Promise<void>; close(): void };
type Execute = (file: string, args: string[], options: ExecFileOptions) => Promise<unknown>;
const execute = promisify(execFile);

export async function openInstalledCodex(run: Execute = execute): Promise<LaunchResult> {
  try {
    await run('/usr/bin/open', ['-b', 'com.openai.codex'], {
      shell: false, env: { LC_ALL: 'C' }, timeout: 8000, maxBuffer: 2048, killSignal: 'SIGKILL',
    });
    return 'accepted';
  } catch (error) {
    // The utility can fail or time out after delivery. Never try again automatically.
    return typeof (error as NodeJS.ErrnoException | undefined)?.code === 'number' ? 'failed' : 'unconfirmed';
  }
}

type Ports = {
  presence(): Promise<CodexPresence>;
  play(): StartupPlayback | undefined;
  open(): Promise<LaunchResult>;
  report(result: Exclude<LaunchResult, 'accepted'>): void;
};

/** Commands are only admitted by trusted native menu or explicit launch mode. */
export class StartupLaunch {
  private closed = false;
  private pending?: Promise<void>;
  private playback?: StartupPlayback;
  constructor(private readonly ports: Ports) {}

  start(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.pending ??= Promise.resolve().then(async () => {
      if (this.closed) return;
      let presence: CodexPresence = 'unknown';
      try { presence = await this.ports.presence(); } catch { /* Do not cover an unconfirmed session. */ }
      if (this.closed) return;
      if (presence === 'not-detected') {
        try { this.playback = this.ports.play(); } catch { /* Opening Codex does not depend on media. */ }
      }
      let result: LaunchResult = 'unconfirmed';
      try { result = await this.ports.open(); } catch { /* Fixed status only. */ }
      if (this.closed) return;
      if (result !== 'accepted') {
        this.closePlayback();
        this.ports.report(result);
        return;
      }
      await this.playback?.done;
    }).finally(() => { this.closePlayback(); this.pending = undefined; });
  }

  dispose(): Promise<void> {
    this.closed = true;
    this.closePlayback();
    return this.pending ?? Promise.resolve();
  }

  private closePlayback(): void {
    const playback = this.playback;
    this.playback = undefined;
    playback?.close();
  }
}
