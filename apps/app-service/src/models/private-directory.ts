import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, unlink, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ModelError } from './errors.ts';
export const absent = (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT';
export const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const storage = (): never => { throw new ModelError('storage_unavailable'); };
/** Internal POSIX storage boundary. Windows needs a host-owned ACL verifier;
 * do not silently treat Unix mode bits there as private storage. */
export class PrivateDirectory {
  private identity?: Stats;
  readonly root: string;
  constructor(root: string, private readonly createMissing = true) {
    if (!isAbsolute(root)) storage(); this.root = resolve(root);
  }
  path(name: string): string {
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(name) || name === '.' || name === '..') storage();
    return join(this.root, name);
  }
  private async verifyACL(path: string, expected: Stats): Promise<void> {
    if (process.platform !== 'darwin') return;
    // macOS ACLs may grant access even when the Unix bits say 0700/0600.
    // Fixed read-only metadata command, no shell, no inherited credentials.
    // Conservatively reject every ACL rather than trying to interpret grants.
    let before = expected;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { stdout } = await promisify(execFile)('/bin/ls', ['-lde', path], {
        env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' }, timeout: 2000, maxBuffer: 16_384,
      });
      if (!/^[d-][rwxstST-]{9}[ @+]/.test(stdout) || stdout[10] === '+' || /^\s*\d+:/m.test(stdout)) storage();
      const after = await lstat(path);
      if (!sameFile(before, after) || after.mode !== before.mode || after.uid !== before.uid || after.gid !== before.gid) storage();
      if (after.ctimeMs === before.ctimeMs) return;
      if (!before.isDirectory()) storage();
      // A cooperating writer can create/remove a child while ls runs. Take
      // another complete ACL observation; never ignore changed directory metadata.
      before = after;
    }
    storage();
  }
  async ready(): Promise<void> {
    if (process.platform === 'win32' || !process.getuid) storage();
    let path = parse(this.root).root;
    for (const part of this.root.slice(path.length).split(sep).filter(Boolean)) {
      path = join(path, part);
      if (!this.identity && this.createMissing) {
        try { await mkdir(path, { mode: 0o700 }); }
        catch (e) { if (!(e && typeof e === 'object' && 'code' in e && e.code === 'EEXIST')) throw e; }
      }
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory()) storage();
    }
    const info = await lstat(this.root);
    if (info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o700 || (this.identity && !sameFile(info, this.identity))) storage();
    await this.verifyACL(this.root, info); this.identity = info;
  }
  private regular(info: Stats): void {
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o600) storage();
  }
  async read(name: string, limit: number, onPresent?: () => void): Promise<{ bytes: Buffer; info: Stats } | undefined> {
    await this.ready();
    const path = this.path(name);
    const info = await lstat(path).catch(e => { if (absent(e)) return undefined; throw e; });
    if (!info) return undefined;
    onPresent?.();
    this.regular(info); if (info.size > limit) storage();
    await this.verifyACL(path, info);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat(); this.regular(opened);
      if (!sameFile(info, opened) || opened.size > limit) storage();
      const bytes = Buffer.alloc(limit + 1); let size = 0;
      while (size < bytes.length) {
        const part = await handle.read(bytes, size, bytes.length - size, size);
        if (!part.bytesRead) break; size += part.bytesRead;
      }
      const end = await handle.stat(); this.regular(end);
      if (size > limit || end.size !== size || end.mtimeMs !== opened.mtimeMs || end.ctimeMs !== opened.ctimeMs) storage();
      await this.ready(); const current = await lstat(path);
      if (!sameFile(end, current)) storage();
      return { bytes: bytes.subarray(0, size), info: end };
    } finally { await handle.close(); }
  }
  async create(name: string): Promise<FileHandle> {
    await this.ready();
    const handle = await open(this.path(name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.chmod(0o600); this.regular(await handle.stat());
      await this.verifyACL(this.path(name), await handle.stat()); return handle;
    } catch (e) { await handle.close(); throw e; }
  }
  async removeOwned(name: string, identity: Stats): Promise<void> {
    await this.ready(); const path = this.path(name);
    const info = await lstat(path).catch(e => { if (absent(e)) return undefined; throw e; });
    if (info && sameFile(identity, info)) await unlink(path);
    else if (info) storage();
  }
  async sync(): Promise<void> {
    await this.ready(); const handle = await open(this.root, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    try { if (!sameFile(await handle.stat(), this.identity!)) storage(); await handle.sync(); }
    finally { await handle.close(); }
  }
}
