import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isChatProjectNew, isHistoryResult, isProjectListResult, maxChatProjects, type ChatProjectBridge } from '../../../packages/contracts/src/chat-history.ts';

type Dependencies = {
  eligible(): boolean;
  select(): Promise<{ canceled: boolean; filePaths: string[] }>;
  list(input: { petID: string }): Promise<unknown>;
  register(input: { petID: string; project: { id: string; name: string } }): Promise<unknown>;
};

/** No path is accepted from or returned to the renderer. Never reuse an existing directory. */
export async function createChatProject(input: unknown, deps: Dependencies): ReturnType<ChatProjectBridge['create']> {
  if (!deps.eligible() || !isChatProjectNew(input)) return { ok: false, error: 'invalid_request' };
  let created = false;
  try {
    const current = await deps.list({ petID: input.petID });
    if (!isProjectListResult(current)) return { ok: false, error: 'unavailable' };
    if (!current.ok) return current;
    if (current.projects.length >= maxChatProjects) return { ok: false, error: 'busy' };
    if (!deps.eligible()) return { ok: false, error: 'cancelled' };
    const selected = await deps.select();
    const parent = selected.filePaths[0];
    if (!deps.eligible() || selected.canceled || selected.filePaths.length !== 1 || !parent || !isAbsolute(parent)) return { ok: false, error: 'cancelled' };
    const selectedDirectory = await stat(parent);
    const directory = await realpath(parent);
    const beforeCreate = await lstat(directory);
    // Reject a stale selection observed before mkdir. This is not a sandbox
    // against another process with write access to the chosen parent path.
    if (!beforeCreate.isDirectory() || !selectedDirectory.isDirectory() || beforeCreate.dev !== selectedDirectory.dev || beforeCreate.ino !== selectedDirectory.ino) return { ok: false, error: 'unavailable' };
    if (!deps.eligible()) return { ok: false, error: 'cancelled' };
    await mkdir(join(directory, input.name), { mode: 0o700 });
    created = true;
    // Once mkdir succeeds, finish this explicit action without using or returning its path.
    const payload = { petID: input.petID, project: { id: randomUUID(), name: input.name } };
    const result = await deps.register(payload);
    if (isHistoryResult('createProject', payload, result) && result.ok && 'project' in result) {
      return deps.eligible() ? result : { ok: false, error: 'cancelled' };
    }
  } catch (error) {
    if (!created && (error as NodeJS.ErrnoException)?.code === 'EEXIST') return { ok: false, error: 'exists' };
  }
  return { ok: false, error: created ? 'unregistered' : 'unavailable' };
}
