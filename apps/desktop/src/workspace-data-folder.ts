import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspaceFolderResult } from '../../../packages/contracts/src/index.ts';

const profile = ['AnimeDesktopPets', 'cross-platform-dev'] as const;
export const workspaceProfilePath = (appData: string) => join(appData, ...profile);

/** The renderer never supplies or receives a path. Only the trusted main process opens it. */
export class WorkspaceDataFolder {
  private opening = false;
  constructor(private readonly appData: string, private readonly openInShell: (path: string) => Promise<string>) {}

  async open(eligible: () => boolean): Promise<WorkspaceFolderResult> {
    if (!eligible()) return 'unavailable';
    if (this.opening) return 'busy';
    this.opening = true;
    try {
      let target: string;
      try {
        target = await realpath(this.appData);
        for (const part of [...profile, 'workspace']) {
          target = join(target, part);
          if (!(await lstat(target)).isDirectory()) return 'unavailable';
        }
        if (await realpath(target) !== target) return 'unavailable';
      } catch (error) {
        return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'not-ready' : 'unavailable';
      }
      if (!eligible()) return 'unavailable';
      return await this.openInShell(target) === '' ? 'opened' : 'unavailable';
    } catch {
      return 'unavailable';
    } finally {
      this.opening = false;
    }
  }
}
