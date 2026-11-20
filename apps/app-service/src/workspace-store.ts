import { constants, renameSync } from 'node:fs';
import { open, lstat, mkdir, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { definition, revision, shape, theme, type PetError, type Theme } from '../../../packages/contracts/src/pets.ts';
import type { PetRegistry } from './pet-registry.ts';

export class WorkspaceError extends Error { constructor(readonly code: PetError) { super(code); } }
export type WorkspaceState = { schemaVersion: 1; revision: number; theme: Theme; registry: PetRegistry; autoStartConfigured?: true };
const empty = (): WorkspaceState => ({ schemaVersion: 1, revision: 0, theme: 'system', registry: { schemaVersion: 1, instances: [] } });
const limit = 128 * 1024;
const missing = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
function decode(value: unknown): WorkspaceState {
  if (!shape(value, ['schemaVersion', 'revision', 'theme', 'registry', 'autoStartConfigured']) || value.schemaVersion !== 1 || !revision(value.revision) || !theme(value.theme) || (Object.hasOwn(value, 'autoStartConfigured') && value.autoStartConfigured !== true)) throw new WorkspaceError('storage');
  const r = value.registry;
  if (!shape(r, ['schemaVersion', 'instances']) || r.schemaVersion !== 1 || !Array.isArray(r.instances) || r.instances.length > 32 || !r.instances.every(definition) || new Set(r.instances.map(i => i.id)).size !== r.instances.length) throw new WorkspaceError('storage');
  return value as WorkspaceState;
}
/** 独立开发目录，单 writer lease；不抢占崩溃残留锁，不访问旧资料根。 */
export class WorkspaceStore {
  private lease?: FileHandle;
  private rootIdentity?: { dev: number; ino: number };
  constructor(private root: string, private beforeCommit?: () => Promise<void>) {
    if (!isAbsolute(root)) throw new WorkspaceError('storage');
    this.root = resolve(root);
  }
  private async directory() {
    let path = parse(this.root).root;
    for (const part of this.root.slice(path.length).split(sep).filter(Boolean)) {
      path = join(path, part);
      if (!this.rootIdentity) {
        try { await mkdir(path, { mode: 0o700 }); } catch (e) { if (!(e && typeof e === 'object' && 'code' in e && e.code === 'EEXIST')) throw e; }
      }
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new WorkspaceError('storage');
    }
    const info = await lstat(this.root);
    if (this.rootIdentity && (info.ino !== this.rootIdentity.ino || info.dev !== this.rootIdentity.dev)) throw new WorkspaceError('storage');
    this.rootIdentity = { ino: info.ino, dev: info.dev };
  }
  async acquire() {
    await this.directory();
    if (this.lease) return;
    try { this.lease = await open(join(this.root, '.workspace-writer.lock'), 'wx', 0o600); }
    catch (e) { if (e && typeof e === 'object' && 'code' in e && e.code === 'EEXIST') throw new WorkspaceError('busy'); throw e; }
  }
  async read(): Promise<WorkspaceState> {
    await this.acquire();
    const file = join(this.root, 'workspace-state.json');
    let handle: FileHandle | undefined;
    try {
      const info = await lstat(file).catch(e => { if (missing(e)) return undefined; throw e; });
      if (!info) return empty();
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > limit) throw new WorkspaceError('storage');
      handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat();
      if (opened.ino !== info.ino || opened.dev !== info.dev || !opened.isFile() || opened.size > limit) throw new WorkspaceError('storage');
      const buffer = Buffer.alloc(limit + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > limit) throw new WorkspaceError('storage');
      return decode(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))));
    } finally { await handle?.close(); }
  }
  async write(state: WorkspaceState, requireCurrent?: () => void) {
    decode(state);
    await this.acquire();
    const file = join(this.root, 'workspace-state.json');
    // Refuse links/directories before replace; only this process holds the writer lease.
    await this.read();
    const bytes = JSON.stringify(state, null, 2) + '\n';
    if (Buffer.byteLength(bytes) > limit) throw new WorkspaceError('storage');
    const tmp = join(this.root, `.workspace-${randomBytes(16).toString('hex')}.tmp`);
    let handle: FileHandle | undefined;
    try {
      handle = await open(tmp, 'wx', 0o600);
      await handle.writeFile(bytes, 'utf8'); await handle.sync(); await handle.close(); handle = undefined;
      await this.beforeCommit?.();
      await this.directory();
      await this.read();
      if (requireCurrent) {
        // Only the final metadata operation is synchronous, so a service-side
        // stop/pause cannot be delivered between the epoch guard and the commit.
        requireCurrent();
        renameSync(tmp, file);
      } else await rename(tmp, file);
    } finally { await handle?.close(); await unlink(tmp).catch(e => { if (!missing(e)) throw e; }); }
  }
  async close() {
    if (!this.lease) return;
    const lease = this.lease; this.lease = undefined;
    try {
      await this.directory();
      const own = await lease.stat(), current = await lstat(join(this.root, '.workspace-writer.lock'));
      if (own.ino === current.ino && own.dev === current.dev) await unlink(join(this.root, '.workspace-writer.lock'));
    } finally { await lease.close(); }
  }
}
