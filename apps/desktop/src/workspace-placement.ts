import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { workspaceProfilePath } from './workspace-data-folder.ts';

export type WorkspaceBounds = { x: number; y: number; width: number; height: number };
export const workspaceMinimum = { width: 760, height: 560 } as const;
export const workspaceDefault = { width: 1180, height: 800 } as const;
const byteLimit = 512;

export function validWorkspaceBounds(value: unknown): value is WorkspaceBounds {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4) return false;
  const { x, y, width, height } = value as Record<string, unknown>;
  const bounded = (entry: unknown, min: number, max: number) => typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= min && entry <= max;
  return bounded(x, -1_000_000, 1_000_000) && bounded(y, -1_000_000, 1_000_000) && bounded(width, 1, 16384) && bounded(height, 1, 16384);
}

export function sameWorkspaceBounds(a: WorkspaceBounds, b: WorkspaceBounds): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function overlap(a: WorkspaceBounds, b: WorkspaceBounds) {
  return {
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)),
  };
}

function reachableTitleArea(bounds: WorkspaceBounds, areas: readonly WorkspaceBounds[]): WorkspaceBounds | undefined {
  const title = { ...bounds, height: Math.min(24, bounds.height) };
  return areas.find(area => {
    const visible = overlap(title, area);
    return visible.width >= Math.min(96, title.width) && visible.height === title.height;
  });
}

/** Display work areas and saved rectangles are all in Electron's DIP coordinates. */
export function fitWorkspace(saved: WorkspaceBounds | undefined, primary: WorkspaceBounds, areas: readonly WorkspaceBounds[]): WorkspaceBounds {
  let bestArea = primary, bestOverlap = 0;
  if (saved) {
    for (const area of [primary, ...areas]) {
      const visible = overlap(saved, area);
      if (visible.width * visible.height > bestOverlap) {
        bestOverlap = visible.width * visible.height;
        bestArea = area;
      }
    }
  }
  const requested = saved ?? workspaceDefault;
  const width = Math.min(bestArea.width, Math.max(requested.width, workspaceMinimum.width));
  const height = Math.min(bestArea.height, Math.max(requested.height, workspaceMinimum.height));
  const x = saved && bestOverlap ? Math.min(Math.max(saved.x, bestArea.x), bestArea.x + bestArea.width - width) : bestArea.x + Math.floor((bestArea.width - width) / 2);
  const y = saved && bestOverlap ? Math.min(Math.max(saved.y, bestArea.y), bestArea.y + bestArea.height - height) : bestArea.y + Math.floor((bestArea.height - height) / 2);
  return { x, y, width, height };
}

export function planWorkspaceReveal(current: WorkspaceBounds, primary: WorkspaceBounds, areas: readonly WorkspaceBounds[]) {
  const reachable = reachableTitleArea(current, [primary, ...areas]);
  const area = reachable ?? fitWorkspace(current, primary, areas);
  const minimum = { width: Math.min(workspaceMinimum.width, area.width), height: Math.min(workspaceMinimum.height, area.height) };
  return { ...(!reachable && { bounds: area }), minimum };
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

/** Best-effort sidecar owned by this host. Only a missing file permits initial creation. */
export class WorkspacePlacement {
  constructor(private readonly appData: string) {}

  private async folder(): Promise<string> {
    const folder = workspaceProfilePath(await realpath(this.appData));
    if (!(await lstat(folder)).isDirectory() || await realpath(folder) !== folder) throw new Error('invalid window profile');
    return folder;
  }

  private async readAt(path: string): Promise<WorkspaceBounds | undefined> {
    let handle;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (missing(error)) return undefined; throw error; }
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600 || metadata.size > byteLimit) throw new Error('invalid window settings');
      const buffer = Buffer.alloc(byteLimit + 1);
      let cursor = 0;
      while (cursor < buffer.length) {
        const { bytesRead } = await handle.read(buffer, cursor, buffer.length - cursor, null);
        if (!bytesRead) break;
        cursor += bytesRead;
      }
      if (cursor > byteLimit) throw new Error('invalid window settings');
      const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, cursor)));
      if (!data || typeof data !== 'object' || Object.keys(data).length !== 2 || !('version' in data) || data.version !== 1 ||
        !('bounds' in data) || !validWorkspaceBounds(data.bounds)) throw new Error('invalid window settings');
      return data.bounds;
    } finally { await handle.close(); }
  }

  async read(): Promise<WorkspaceBounds | undefined> {
    try { return await this.readAt(join(await this.folder(), 'workspace-window.json')); }
    catch { return undefined; }
  }

  async save(bounds: WorkspaceBounds): Promise<boolean> {
    if (!validWorkspaceBounds(bounds)) return false;
    let temporary: string | undefined;
    try {
      const folder = await this.folder();
      const target = join(folder, 'workspace-window.json');
      const previous = await this.readAt(target);
      if (previous && sameWorkspaceBounds(previous, bounds)) return true;
      const candidate = join(folder, `.workspace-window-${randomUUID()}.tmp`);
      const writer = await open(candidate, 'wx', 0o600);
      temporary = candidate;
      try {
        await writer.chmod(0o600);
        await writer.writeFile(JSON.stringify({ version: 1, bounds }), 'utf8');
        await writer.sync();
      } finally { await writer.close(); }
      if (await this.folder() !== folder) return false;
      const current = await this.readAt(target);
      if (previous ? !current || !sameWorkspaceBounds(previous, current) : current) return false;
      await rename(candidate, target);
      temporary = undefined;
      return true;
    } catch { return false; }
    finally { if (temporary) await unlink(temporary).catch(() => {}); }
  }
}
