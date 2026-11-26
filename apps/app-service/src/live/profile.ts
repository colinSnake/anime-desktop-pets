import { randomBytes } from 'node:crypto';
import { rename, type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { defaultLiveProfile, isLiveProfile, type LiveProfile } from '../../../../packages/contracts/src/live-stage.ts';
import { PrivateDirectory, sameFile } from '../models/private-directory.ts';

// The fixed profile path now stores schema v2; older schema files are rejected, not migrated.
const file = 'stage-profile.json';
const limit = 2048;
const invalid = () => new Error('invalid_live_profile');
function parse(bytes: Buffer): LiveProfile {
  const value: unknown = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
  if (!isLiveProfile(value)) throw invalid();
  return value;
}
/** Only used by the utility service after taking the workspace writer lease. */
export class LiveProfileStore {
  private readonly directory: PrivateDirectory;
  private tail: Promise<unknown> = Promise.resolve();
  private closing = false;
  constructor(root: string) { this.directory = new PrivateDirectory(root); }
  private run<T>(op: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(invalid());
    const current = this.tail.then(op); this.tail = current.catch(() => {}); return current;
  }
  close() { this.closing = true; return this.tail; }
  read(): Promise<LiveProfile> { return this.run(async () => {
    const row = await this.directory.read(file, limit);
    return row ? parse(row.bytes) : defaultLiveProfile();
  }); }
  write(profile: LiveProfile): Promise<LiveProfile> { return this.run(async () => {
    if (!isLiveProfile(profile)) throw invalid();
    const old = await this.directory.read(file, limit);
    if (old) parse(old.bytes);
    const temporary = `.stage-${randomBytes(12).toString('hex')}.tmp`;
    let handle: FileHandle | undefined, identity: Stats | undefined;
    try {
      handle = await this.directory.create(temporary);
      identity = await handle.stat();
      await handle.writeFile(JSON.stringify(profile));
      await handle.sync(); await handle.close(); handle = undefined;
      const latest = await this.directory.file(file);
      if (old ? !latest || !sameFile(old.info, latest) || old.info.ctimeMs !== latest.ctimeMs : latest) throw invalid();
      await rename(this.directory.path(temporary), this.directory.path(file));
      await this.directory.sync();
      return profile;
    } finally {
      await handle?.close().catch(() => {});
      if (identity) await this.directory.removeOwned(temporary, identity).catch(() => {});
    }
  }); }
}
