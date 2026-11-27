import { randomBytes } from 'node:crypto';
import { rename, type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { defaultLiveProfile, defaultRoleProfile, isStoredLiveProfile, isLiveRoleProfile, liveRoleIds, type StoredLiveProfile, type LiveRoleId, type LiveRoleProfile } from '../../../../packages/contracts/src/live-stage.ts';
import { PrivateDirectory, sameFile } from '../models/private-directory.ts';

const file = 'stage-profile.json';
const limit = 4096;
const invalid = () => new Error('invalid_live_profile');
type Stored = StoredLiveProfile;
function parse(bytes: Buffer): Stored {
  const value: unknown = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
  if (isStoredLiveProfile(value)) return value;
  // One-time schema-v2 migration: preserve the complete legacy layout for longmei.
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 3 &&
      (value as any).schemaVersion === 2 && typeof (value as any).selected === 'string' && (value as any).scenes) {
    const dragon = {...value as any, schemaVersion:3};
    const migrated = {schemaVersion:3, selected:dragon.selected, roles:{longmei:{scenes:dragon.scenes}, dafeiyu:{scenes:defaultRoleProfile().scenes}}};
    if (isStoredLiveProfile(migrated)) return migrated;
  }
  throw invalid();
}
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
  private async readStored(): Promise<{profile:Stored; row:Awaited<ReturnType<PrivateDirectory['read']>>}> {
    const row = await this.directory.read(file, limit);
    const defaults = defaultLiveProfile();
    return {profile:row ? parse(row.bytes) : {schemaVersion:3,selected:defaults.selected,roles:{longmei:{scenes:defaults.scenes},dafeiyu:{scenes:defaultRoleProfile().scenes}}}, row};
  }
  read(role: LiveRoleId = 'longmei'): Promise<LiveRoleProfile> { return this.run(async () => {
    if (!liveRoleIds.includes(role)) throw invalid();
    const {profile,row} = await this.readStored();
    if (row && !isStoredLiveProfile(JSON.parse(row.bytes.toString('utf8')))) await this.persist(profile, row);
    return {schemaVersion:3,selected:profile.selected,scenes:profile.roles[role].scenes};
  }); }
  write(profile: LiveRoleProfile, role: LiveRoleId = 'longmei'): Promise<LiveRoleProfile> { return this.run(async () => {
    if (!liveRoleIds.includes(role) || !isLiveRoleProfile(profile)) throw invalid();
    const {profile:stored,row} = await this.readStored();
    const next: Stored = {...stored, selected:profile.selected, roles:{...stored.roles,[role]:{scenes:profile.scenes}}};
    await this.persist(next,row);
    return profile;
  }); }
  private async persist(profile:Stored, old:Awaited<ReturnType<PrivateDirectory['read']>>):Promise<void> {
    const temporary = `.stage-${randomBytes(12).toString('hex')}.tmp`;
    let handle: FileHandle | undefined, identity: Stats | undefined;
    try {
      handle = await this.directory.create(temporary); identity = await handle.stat();
      await handle.writeFile(JSON.stringify(profile)); await handle.sync(); await handle.close(); handle = undefined;
      const latest = await this.directory.file(file);
      if (old ? !latest || !sameFile(old.info, latest) || old.info.ctimeMs !== latest.ctimeMs : latest) throw invalid();
      await rename(this.directory.path(temporary), this.directory.path(file)); await this.directory.sync();
    } finally {
      await handle?.close().catch(() => {});
      if (identity) await this.directory.removeOwned(temporary, identity).catch(() => {});
    }
  }
}
