import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdtemp, open, opendir, rename, rm, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PrivateDirectory, absent } from '../../app-service/src/models/private-directory.ts';
import { decodeModelConfiguration, MODEL_CONFIGURATION_LIMIT } from '../../app-service/src/models/configuration-store.ts';
import { decodeModelProbeRecords, MODEL_PROBE_FILE, MODEL_PROBE_LIMIT } from '../../app-service/src/models/probe-store.ts';
import { decodeCharacterState } from '../../app-service/src/characters/repository.ts';
import { CHARACTER_LIMIT } from '../../app-service/src/characters/records.ts';
import { validateWorkspaceState, WORKSPACE_STATE_LIMIT } from '../../app-service/src/workspace-store.ts';
import { petId } from '../../../packages/contracts/src/pets.ts';

const marker = 'selection-v1', receipt = '.adpets-root-v1';
const workspaceFile = 'workspace-state.json', modelFile = 'model-providers.json';
const emptyWorkspace = Buffer.from('{"schemaVersion":1,"revision":0,"theme":"system","registry":{"schemaVersion":1,"instances":[]}}\n');
const emptyModels = Buffer.from('{"schemaVersion":2,"revision":0,"defaultConnectionID":null,"connections":[]}\n');
const stat = (path: string) => lstat(path).catch(error => { if (!absent(error)) throw error; });
const invalid = () => new Error('local_data_unavailable');
const validateWorkspace = (bytes: Buffer) => validateWorkspaceState(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
type FileClaim = { dir: PrivateDirectory; name: string; info: Stats; handle: FileHandle };
export type DataSelection = { kind: 'legacy' | 'adpets'; root: string };

async function claim(dir: PrivateDirectory, name: string): Promise<FileClaim> {
  const handle = await dir.create(name);
  try { return { dir, name, handle, info: await handle.stat() }; }
  catch (error) { await handle.close(); throw error; }
}
async function release(owned: FileClaim, retain = false) {
  try {
    if (!retain) { await owned.dir.removeOwned(owned.name, owned.info); await owned.dir.sync(); }
  } finally { await owned.handle.close(); }
}
async function write(dir: PrivateDirectory, name: string, bytes: Buffer) {
  const file = await dir.create(name);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
async function syncParent(path: string) {
  const handle = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

export class LocalDataRoot {
  readonly target: string;
  private readonly control: PrivateDirectory;
  constructor(home: string, private readonly legacy: string, private readonly publish: typeof rename = rename) {
    this.target = join(home, '.adpets');
    this.control = new PrivateDirectory(join(legacy, '.adpets-control'));
  }

  private async legacyExists() {
    return !!(await stat(join(this.legacy, 'workspace')) || await stat(join(this.legacy, 'models')));
  }

  private async selected(): Promise<DataSelection | undefined> {
    const intent = await this.control.read(marker, 64);
    if (!intent) return;
    if (!/^[0-9a-f-]{36}\n$/.test(intent.bytes.toString('ascii'))) throw invalid();
    const target = new PrivateDirectory(this.target, false);
    const published = await target.read(receipt, 64);
    if (!published?.bytes.equals(intent.bytes)) throw invalid();
    await this.verifyBusinessFiles(this.target);
    // Confirm parent durability again if a prior publisher lost its acknowledgement.
    await syncParent(this.target);
    return { kind: 'adpets', root: this.target };
  }

  async select(): Promise<DataSelection> {
    const selected = await this.selected();
    if (selected) return selected;
    return this.exclusive(async () => {
      if (await stat(this.target)) throw invalid();
      if (await this.legacyExists()) return { kind: 'legacy', root: this.legacy };
      await this.create(false);
      return { kind: 'adpets', root: this.target };
    });
  }

  /** Trusted main calls this only after native confirmation and confirmed service shutdown. */
  async migrate(): Promise<void> {
    await this.exclusive(async () => {
      if (!(await this.legacyExists()) || await stat(this.target)) throw invalid();
      await this.create(true);
    });
  }

  private async exclusive<T>(operation: () => Promise<T>) {
    const lock = await claim(this.control, '.publish.lock');
    try {
      if (await this.control.read(marker, 64)) throw invalid();
      return await operation();
    } finally { await release(lock); }
  }

  private async verifyBusinessFiles(root: string) {
    const workspace = new PrivateDirectory(join(root, 'workspace'), false);
    const models = new PrivateDirectory(join(root, 'models'), false);
    const ws = await workspace.read(workspaceFile, WORKSPACE_STATE_LIMIT);
    const configs = await models.read(modelFile, MODEL_CONFIGURATION_LIMIT);
    if (!ws || !configs) throw invalid();
    validateWorkspace(ws.bytes); decodeModelConfiguration(configs.bytes);
    // Probe receipts are optional diagnostics. Validate them when copying the
    // legacy source, not when reopening a published root; the model service
    // guards receipt reads and writes independently of the configuration.
    await new PrivateDirectory(join(root, 'live'), false).ready();
    // Older selected roots gain reserved local Agent/Skill directories, never imported content.
    for (const name of ['agents', 'skills']) await new PrivateDirectory(join(root, name)).sync();
    await new PrivateDirectory(root, false).sync();
    await new PrivateDirectory(join(root, 'workspace', 'characters'), false).ready();
  }

  private async create(migrate: boolean) {
    const seals: FileClaim[] = [];
    let stage: string | undefined;
    let intent: FileClaim | undefined;
    let publishing = false;
    let retain = false;
    try {
      const oldWorkspace = new PrivateDirectory(join(this.legacy, 'workspace'));
      const oldModels = new PrivateDirectory(join(this.legacy, 'models'));
      if (migrate) {
        // These are the locks already honored by earlier Electron releases.
        // The short writer lock orders creation of the durable online fence.
        seals.push(await claim(oldWorkspace, '.workspace-writer.lock'));
        const short = await claim(oldModels, '.models-writer.lock');
        try { seals.push(await claim(oldModels, '.models-online-owner.lock')); }
        finally { await release(short); }
        for (const seal of seals) { await seal.handle.sync(); await seal.dir.sync(); }
      }
      stage = await mkdtemp(join(dirname(this.target), '.adpets-stage-'));
      const root = new PrivateDirectory(stage, false);
      const workspace = new PrivateDirectory(join(stage, 'workspace'));
      const models = new PrivateDirectory(join(stage, 'models'));
      const characters = new PrivateDirectory(join(stage, 'workspace', 'characters'));
      const live = new PrivateDirectory(join(stage, 'live'));
      const ws = (migrate ? (await oldWorkspace.read(workspaceFile, WORKSPACE_STATE_LIMIT))?.bytes : undefined) ?? emptyWorkspace;
      const configs = (migrate ? (await oldModels.read(modelFile, MODEL_CONFIGURATION_LIMIT))?.bytes : undefined) ?? emptyModels;
      validateWorkspace(ws); decodeModelConfiguration(configs);
      await write(workspace, workspaceFile, ws); await write(models, modelFile, configs);
      if (migrate) {
        const probes = await oldModels.read(MODEL_PROBE_FILE, MODEL_PROBE_LIMIT);
        if (probes) { decodeModelProbeRecords(probes.bytes); await write(models, MODEL_PROBE_FILE, probes.bytes); }
      }
      if (migrate) await this.copyCharacters(new PrivateDirectory(join(oldWorkspace.root, 'characters'), false), characters);
      for (const dir of [live, characters, models, workspace]) await dir.sync();
      const token = Buffer.from(`${randomUUID()}\n`);
      await write(root, 'chats.sqlite', Buffer.alloc(0));
      await write(root, receipt, token); await root.sync();
      await this.verifyBusinessFiles(stage);
      if (await stat(this.target)) throw invalid();
      intent = await claim(this.control, marker);
      await intent.handle.writeFile(token); await intent.handle.sync(); await this.control.sync();
      await syncParent(this.control.root);
      publishing = true;
      await this.publish(stage, this.target);
      retain = true;
      await syncParent(this.target);
    } catch (error) {
      if (publishing) retain = await stat(this.target).then(Boolean, () => true);
      throw error;
    } finally {
      try {
        if (intent) {
          // Never unselect a potentially published target or release its legacy fences.
          try { await release(intent, retain); }
          catch (error) { retain = true; throw error; }
        }
      } finally {
        const outcomes = await Promise.allSettled(seals.reverse().map(seal => release(seal, retain)));
        if (stage) await rm(stage, { recursive: true, force: true });
        if (outcomes.some(result => result.status === 'rejected')) throw invalid();
      }
    }
  }

  private async copyCharacters(source: PrivateDirectory, target: PrivateDirectory) {
    if (!await stat(source.root)) return;
    await source.ready();
    let entries = 0, bytes = 0;
    for await (const entry of await opendir(source.root)) {
      if (++entries > 4096 || entry.name.endsWith('.lock')) throw invalid();
      const id = entry.name.endsWith('.json') ? entry.name.slice(0, -5) : '';
      if (!petId(id)) continue;
      const file = await source.read(entry.name, CHARACTER_LIMIT);
      if (!file || (bytes += file.bytes.length) > 128 * 1024 * 1024) throw invalid();
      decodeCharacterState(file.bytes, id);
      await write(target, entry.name, file.bytes);
    }
  }
}
