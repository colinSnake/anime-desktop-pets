import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { decodeLegacyGoal, decodeLegacyIdentity, decodeLegacyMemory } from '../../app-service/src/migration/legacy-character.ts';
import { isLegacyImportBatch, isLegacyImportGoal, isLegacyImportMemory, legacyHandoffBodyLimit,
  type LegacyCharacterSnapshotResult, type LegacyImportBatch, type SnapshotRecordCount,
} from '../../../packages/contracts/src/legacy-character-snapshot.ts';
import { identityFields, isIdentityDraft } from '../../../packages/contracts/src/characters.ts';

type Failure = Extract<LegacyCharacterSnapshotResult, { ok: false }>['error'];
class SnapshotError extends Error { constructor(readonly kind: Failure) { super(kind); } }
const fail = (kind: Failure): never => { throw new SnapshotError(kind); };
const unavailable = { ok: false, error: 'unavailable' } as const;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 128;
const MAX_DIRECTORY_ENTRIES = 256;
type Source = { path: string; info: BigIntStats };
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink &&
  a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const inTree = (root: string, path: string) => path === root || path.startsWith(`${root}${sep}`);

async function source(path: string): Promise<Source | undefined> {
  try { return { path, info: await lstat(path, { bigint: true }) }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    return undefined;
  }
}
async function assertUnchanged(pinned: Source): Promise<void> {
  const current = await source(pinned.path);
  if (!current || !same(current.info, pinned.info) || await realpath(pinned.path) !== pinned.path) fail('changed');
}

/** No lookup of the default old profile, no recursive scan and no writes. Only the
 * explicit selection is opened. The optional trusted callback receives an all-valid draft batch. */
export async function inspectLegacyCharacterSnapshot(path: string, appData: string, clock: string,
  stillCurrent: () => boolean = () => true, retain?: (batch: LegacyImportBatch) => void): Promise<LegacyCharacterSnapshotResult> {
  try {
    if (!stillCurrent()) return unavailable;
    if (!isAbsolute(path) || path.length > 4096 || path.includes('\0') || path !== normalize(path) || dirname(path) === path) return fail('unsafe');
    const selected = await source(path);
    if (!selected?.info.isDirectory()) return fail('unsafe');
    const target = await realpath(path);
    // Resolve the OS's symlinked appData prefix, then refuse both aliases of the
    // legacy/current data tree and normal spelling variations on macOS.
    const application = (await realpath(join(appData, 'AnimeDesktopPets')).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return realpath(appData).then(base => join(base, 'AnimeDesktopPets'));
    })).toLowerCase();
    if (inTree(application, target.toLowerCase()) || inTree(application, path.toLowerCase())) return fail('unsafe');
    const root = { path: target, info: selected.info };
    await assertUnchanged(root);

    const pinnedDirs = [root], pinnedFiles: Source[] = [];
    let bytes = 0;
    const record = async (file: string) => {
      const item = await source(file);
      if (!item) return undefined;
      if (!item.info.isFile() || item.info.nlink !== 1n) return fail('unsafe');
      if (item.info.size > MAX_FILE_BYTES || pinnedFiles.length >= MAX_FILES) return fail('limit');
      bytes += Number(item.info.size);
      if (bytes > MAX_BYTES) return fail('limit');
      pinnedFiles.push(item);
      return item;
    };
    const index = async (name: 'memories' | 'plans') => {
      const dir = await source(join(root.path, name));
      if (!dir) return { dir: root, files: [] as { id: string; item: Source }[] };
      if (!dir.info.isDirectory()) return fail('unsafe');
      pinnedDirs.push(dir);
      await assertUnchanged(root);
      await assertUnchanged(dir);
      const files: { id: string; item: Source }[] = [];
      let entries = 0;
      for await (const entry of await opendir(dir.path)) {
        if (++entries > MAX_DIRECTORY_ENTRIES) return fail('limit');
        if (entry.name.startsWith('.') || !entry.name.endsWith('.md')) continue;
        const item = await record(join(dir.path, entry.name));
        if (!item) return fail('changed');
        files.push({ id: entry.name.slice(0, -3), item });
      }
      await assertUnchanged(dir);
      return { dir, files };
    };
    const identity = await record(join(root.path, 'identity.md'));
    const memories = await index('memories'), goals = await index('plans');
    if (pinnedFiles.length === 0) return fail('empty');

    const read = async (item: Source, dir: Source, decode: (content: Uint8Array) => unknown): Promise<boolean> => {
      if (!stillCurrent()) return fail('unavailable');
      await assertUnchanged(root);
      if (dir !== root) await assertUnchanged(dir);
      await assertUnchanged(item);
      const file = await open(item.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!same(await file.stat({ bigint: true }), item.info)) return fail('changed');
        await assertUnchanged(root);
        if (dir !== root) await assertUnchanged(dir);
        const buffer = Buffer.alloc(Number(item.info.size) + 1);
        let used = 0;
        while (used < buffer.length) {
          const { bytesRead } = await file.read(buffer, used, buffer.length - used, used);
          if (!bytesRead) break;
          used += bytesRead;
        }
        if (BigInt(used) !== item.info.size || !same(await file.stat({ bigint: true }), item.info)) return fail('changed');
        try { decode(buffer.subarray(0, used)); return true; }
        catch { return false; }
      } finally { await file.close(); }
    };
    const count = async ({ dir, files }: Awaited<ReturnType<typeof index>>, decode: (content: Uint8Array, id: string) => unknown) => {
      const total: SnapshotRecordCount = { recognized: 0, invalid: 0 };
      for (const { item, id } of files) total[await read(item, dir, content => decode(content, id)) ? 'recognized' : 'invalid']++;
      return total;
    };
    const batch: LegacyImportBatch = { identity: null, memories: [], goals: [] };
    const report = {
      identity: !identity ? 'missing' : await read(identity, root, content => {
        const old = decodeLegacyIdentity(content, clock);
        const draft = Object.fromEntries(['name', ...identityFields].map(key => [key, old[key as keyof typeof old]]));
        if (!isIdentityDraft(draft)) throw Error();
        batch.identity = draft;
      }) ? 'recognized' : 'invalid',
      memories: await count(memories, (content, id) => {
        const { kind, text, source, citation, version, expiresAt } = decodeLegacyMemory(content, id);
        const draft = { kind, text, source, citation, version, ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}) };
        if (!isLegacyImportMemory(draft)) throw Error();
        batch.memories.push(draft);
      }),
      goals: await count(goals, (content, id) => {
        const { title, details, status, steps } = decodeLegacyGoal(content, id);
        const draft = { title, details, status, steps: steps.map(({ text, isComplete }) => ({ text, isComplete })) };
        if (!isLegacyImportGoal(draft)) throw Error();
        batch.goals.push(draft);
      }),
    } as const;
    for (const item of [...pinnedDirs, ...pinnedFiles]) await assertUnchanged(item);
    if (!stillCurrent()) return unavailable;
    if (retain && report.identity !== 'invalid' && !report.memories.invalid && !report.goals.invalid && isLegacyImportBatch(batch) &&
        Buffer.byteLength(JSON.stringify(batch)) < legacyHandoffBodyLimit - 1024) retain(batch);
    return { ok: true, report };
  } catch (error) {
    return error instanceof SnapshotError ? { ok: false, error: error.kind } : unavailable;
  }
}
