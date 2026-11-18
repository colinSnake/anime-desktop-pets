import type { PetLifecycle } from './pet-lifecycle.ts';
import { CodexTaskLease } from './codex-task-lease.ts';
import { randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { catalogEntry, isPetInput, petId, type CatalogEntry, type LinkageState, type PackageImportResult, type PetAction, type PetDefinition, type PetInputs, type PetPhase, type PetResult, type WorkspaceData } from '../../../packages/contracts/src/pets.ts';
import { defaultPreferences } from './pet-registry.ts';
import { WorkspaceError, WorkspaceStore, type WorkspaceState } from './workspace-store.ts';
export class PetWorkspace {
  private store: WorkspaceStore;
  private queue: Promise<unknown> = Promise.resolve();
  private closing?: Promise<void>;
  private catalog: CatalogEntry[];
  private phase: (id: string) => PetPhase;
  private lifecycle?: PetLifecycle;
  private linkage: LinkageState = 'active';
  private pauseRequested = false;
  readonly taskLease = new CodexTaskLease({ canFollow: () => this.canStartOwnedPlayer() });
  private stopAdditional?: () => Promise<boolean>;
  private onPauseRequested?: () => void;
  constructor(options: { root: string; catalog: CatalogEntry[]; lifecycle?: PetLifecycle; stopAdditional?: () => Promise<boolean>; onPauseRequested?: () => void; phase?: (id: string) => PetPhase; beforeCommit?: () => Promise<void>; importOne?: (path: string) => Promise<{ name: string; package: CatalogEntry }> }) {
    if (options.catalog.length > 32 || !options.catalog.every(catalogEntry) || new Set(options.catalog.map(c => `${c.id}@${c.version}`)).size !== options.catalog.length) throw new Error('invalid_catalog');
    this.catalog = structuredClone(options.catalog);
    this.lifecycle = options.lifecycle;
    this.stopAdditional = options.stopAdditional;
    this.onPauseRequested = options.onPauseRequested;
    this.importOne = options.importOne;
    this.phase = options.phase ?? (() => 'not-connected');
    this.store = new WorkspaceStore(options.root, options.beforeCommit);
    this.lifecycle?.setPositionWriter(async (id, position) => (await this.recordRuntimePosition(id, position)).ok);
  }
  private importOne?: (path: string) => Promise<{ name: string; package: CatalogEntry }>;
  private view(state: WorkspaceState): WorkspaceData {
    return structuredClone({ revision: state.revision, theme: state.theme, catalog: this.catalog, maximumRunning: 3, linkage: this.pauseRequested ? 'pausing' : this.linkage, instances: state.registry.instances.map(row => ({ ...row, phase: this.lifecycle?.phase(row) ?? this.phase(row.id), ...(this.lifecycle?.applied(row) ? { applied: this.lifecycle.applied(row) } : {}), ...(this.lifecycle?.behavior(row) ? { behavior: this.lifecycle.behavior(row) } : {}), ...(this.lifecycle?.positionFeedback(row) ? { positionFeedback: this.lifecycle.positionFeedback(row) } : {}) })) });
  }
  private run(operation: () => Promise<PetResult>): Promise<PetResult> {
    if (this.closing) return Promise.resolve({ ok: false, error: 'unavailable' });
    const result = this.queue.then(operation).catch((e: unknown): PetResult => ({ ok: false, error: e instanceof WorkspaceError ? e.code : 'storage' }));
    this.queue = result;
    return result;
  }
  list(): Promise<PetResult> { return this.run(async () => ({ ok: true, workspace: this.view(await this.store.read()) })); }
  /** Trusted service operations share ordering with instance creation and deletion. */
  withRegisteredInstance<T>(id: unknown, operation: (id: string) => Promise<T>): Promise<T> {
    if (!petId(id)) return Promise.reject(new WorkspaceError('invalid'));
    if (this.closing) return Promise.reject(new WorkspaceError('unavailable'));
    const result = this.queue.then(async () => {
      if (this.closing) throw new WorkspaceError('unavailable');
      const state = await this.store.read();
      if (!state.registry.instances.some(row => row.id === id)) throw new WorkspaceError('not-found');
      if (this.closing) throw new WorkspaceError('unavailable');
      return operation(id);
    });
    this.queue = result.catch(() => {});
    return result;
  }
  importPackages(paths: unknown): Promise<PackageImportResult> {
    if (this.closing) return Promise.resolve({ ok: false, error: 'unavailable' });
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > 16 || !paths.every(path => typeof path === 'string' && isAbsolute(path) && path.length <= 4096) || new Set(paths).size !== paths.length || paths.reduce((sum, path) => sum + Buffer.byteLength(path as string), 0) > 56 * 1024) return Promise.resolve({ ok: false, error: 'invalid' });
    if (!this.importOne) return Promise.resolve({ ok: false, error: 'unavailable' });
    const operation = this.queue.then(async (): Promise<PackageImportResult> => {
      const items: Extract<PackageImportResult, { ok: true }>['items'] = [];
      for (const path of paths as string[]) {
        const selectedName = path.split(/[\\/]/).pop()?.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 255);
        const name = selectedName && selectedName !== '.' && selectedName !== '..' ? selectedName : '未命名素材';
        try {
          const imported = await this.importOne!(path);
          if (!catalogEntry(imported.package)) throw new WorkspaceError('invalid');
          const existing = this.catalog.find(item => item.id === imported.package.id && item.version === imported.package.version);
          if (existing && (existing.name !== imported.package.name || existing.launchable !== imported.package.launchable)) throw new WorkspaceError('conflict');
          if (!existing && this.catalog.length >= 32) throw new WorkspaceError('limit');
          if (!existing) this.catalog.push(structuredClone(imported.package));
          items.push({ name, status: 'added', package: { id: imported.package.id, version: imported.package.version } });
        } catch {
          items.push({ name, status: 'failed' });
        }
      }
      return { ok: true, items };
    });
    this.queue = operation.catch(() => undefined);
    return operation.catch(() => ({ ok: false, error: 'unavailable' }));
  }
  updateTaskAnimation(snapshot: import('./codex-task-lease.ts').TaskSnapshot | undefined): void {
    if (!snapshot || this.canStartOwnedPlayer()) this.lifecycle?.updateTaskAnimation(snapshot);
  }
  canStartOwnedPlayer(): boolean { return this.linkage === 'active' && !this.pauseRequested && !this.closing; }
  recordRuntimePosition(id: string, position: { x: number; y: number }): Promise<PetResult> {
    return this.run(async () => {
      if (typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) ||
          !position || !Number.isSafeInteger(position.x) || !Number.isSafeInteger(position.y) ||
          Math.abs(position.x) > 1_000_000 || Math.abs(position.y) > 1_000_000) throw new WorkspaceError('invalid');
      const state = await this.store.read();
      const row = state.registry.instances.find(item => item.id === id);
      if (!row) throw new WorkspaceError('not-found');
      if (row.preferences.x === position.x && row.preferences.y === position.y) return { ok: true, workspace: this.view(state) };
      row.preferences.x = position.x;
      row.preferences.y = position.y;
      state.revision++;
      await this.store.write(state);
      return { ok: true, workspace: this.view(state) };
    });
  }
  mutate(action: PetAction, input: unknown): Promise<PetResult> {
    if (action === 'resume' && (this.pauseRequested || this.linkage === 'pausing' || this.linkage === 'stop-unconfirmed')) return Promise.resolve({ ok: false, error: 'active' });
    if (action === 'pause' && isPetInput(action, input) && !this.pauseRequested && ['active', 'stop-unconfirmed'].includes(this.linkage)) {
      this.pauseRequested = true;
      this.taskLease.disable();
      this.onPauseRequested?.();
    }
    const operation = this.run(async () => {
      if (!isPetInput(action, input)) throw new WorkspaceError('invalid');
      const state = await this.store.read();
      if (input.expectedRevision !== state.revision) throw new WorkspaceError('conflict');
      const rows = state.registry.instances;
      if (action === 'pause') {
        if (!this.pauseRequested) return { ok: true, workspace: this.view(state) };
        this.linkage = 'pausing';
        let stoppedInstances = true;
        try { stoppedInstances = await (this.lifecycle?.pauseAll() ?? Promise.resolve(true)); } catch { stoppedInstances = false; }
        let stoppedAdditional = true;
        try { stoppedAdditional = await (this.stopAdditional?.() ?? Promise.resolve(true)); } catch { stoppedAdditional = false; }
        this.linkage = stoppedInstances && stoppedAdditional ? 'paused' : 'stop-unconfirmed';
        this.pauseRequested = false;
        if (this.linkage === 'stop-unconfirmed') throw new WorkspaceError('apply-failed');
        return { ok: true, workspace: this.view(state) };
      }
      if (action === 'resume') {
        if (this.linkage === 'stop-unconfirmed' || this.linkage === 'pausing') throw new WorkspaceError('active');
        if (this.linkage === 'paused') { this.lifecycle?.resumeAll(); this.linkage = 'active'; }
        return { ok: true, workspace: this.view(state) };
      }
      if (action === 'theme') state.theme = (input as PetInputs['theme']).theme;
      else if (action === 'add') {
        const wanted = (input as PetInputs['add']).package;
        const item = this.catalog.find(c => c.id === wanted.id && c.version === wanted.version);
        if (!item) throw new WorkspaceError('package-unavailable');
        if (rows.length >= 32) throw new WorkspaceError('limit');
        rows.push({ id: `pet-${randomBytes(10).toString('hex')}`, package: { ...wanted }, displayName: item.name, enabled: true, autoStartOnLaunch: false, preferences: defaultPreferences() });
      } else {
        const id = (input as PetInputs['clone']).id;
        const row = rows.find(r => r.id === id);
        if (!row) throw new WorkspaceError('not-found');
        if (action === 'start' || action === 'stop') {
          if (action === 'start' && (this.linkage !== 'active' || this.pauseRequested)) throw new WorkspaceError('busy');
          if (!this.lifecycle) throw new WorkspaceError('unavailable');
          const error = this.lifecycle[action](row);
          if (error) throw new WorkspaceError(error);
          return { ok: true, workspace: this.view(state) };
        } else if (action === 'applyDisplay' || action === 'applyBehavior' || action === 'visibility') {
          if (this.linkage !== 'active' || this.pauseRequested) throw new WorkspaceError('busy');
          if (!this.lifecycle) throw new WorkspaceError('unavailable');
          const error = action === 'applyDisplay' ? await this.lifecycle.applyDisplayPreferences(row) : action === 'applyBehavior' ? await this.lifecycle.applyBehaviorPreferences(row) : await this.lifecycle.setVisible(row, (input as PetInputs['visibility']).visible);
          if (error) throw new WorkspaceError(error);
          return { ok: true, workspace: this.view(state) };
        } else if (action === 'clone') {
          if (rows.length >= 32) throw new WorkspaceError('limit');
          // A deleted clone may still own private data; never derive or recycle its ID.
          const next = `pet-${randomBytes(10).toString('hex')}`;
          const copy: PetDefinition = structuredClone(row);
          copy.id = next; copy.autoStartOnLaunch = false;
          copy.displayName = [...(row.displayName ?? '桌宠')].slice(0, 77).join('') + '·分身';
          delete copy.preferences.x; delete copy.preferences.y;
          rows.push(copy);
        } else if (action === 'delete') {
          if (!['stopped', 'not-connected'].includes(this.lifecycle?.phase(row) ?? this.phase(id))) throw new WorkspaceError('active');
          await this.lifecycle?.forget(row);
          state.registry.instances = rows.filter(r => r.id !== id);
        } else if (action === 'save') {
          const save = input as PetInputs['save'];
          Object.assign(row, { displayName: save.displayName.trim(), enabled: save.enabled, autoStartOnLaunch: save.autoStartOnLaunch, preferences: structuredClone(save.preferences) });
        }
      }
      state.revision++;
      await this.store.write(state);
      return { ok: true, workspace: this.view(state) };
    });
    return action === 'pause' ? operation.then(result => { if (!result.ok) this.pauseRequested = false; return result; }) : operation;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.queue.then(async () => {
      const results = await Promise.allSettled([() => this.lifecycle?.close(), () => this.store.close()].map(close => Promise.resolve().then(close)));
      if (results.some(result => result.status === 'rejected')) throw new Error('workspace_cleanup_failed');
    });
    this.taskLease.disable();
    return this.closing;
  }
}
