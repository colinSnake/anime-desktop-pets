import type { PackageReference, PetDefinition, PetError, PetInputs, PetResult, PetsBridge, Theme, WorkspaceData } from '../../../packages/contracts/src/pets.ts';
import { isPetInput } from '../../../packages/contracts/src/pets.ts';
import { isDafeiyu } from '../../../packages/contracts/src/built-in-pets.ts';
import { importPetPackages, requestPets } from './pet-client.ts';

export type PetDraft = Pick<PetDefinition, 'displayName' | 'enabled' | 'autoStartOnLaunch' | 'preferences'> & { displayName: string };
export type PetWorkspaceState = {
  workspace?: WorkspaceData;
  selectedId?: string;
  drafts: Record<string, PetDraft>;
  operation?: 'load' | 'importPackages' | keyof PetInputs;
  error?: PetError;
  notice: string;
  needsRefresh: boolean;
  deleteId?: string;
  runtimeStale?: boolean;
};
export const emptyPetState: PetWorkspaceState = { drafts: Object.create(null) as Record<string, PetDraft>, notice: '', needsRefresh: false };
export function petDisplayName(pet: PetDefinition, workspace?: WorkspaceData) {
  const saved = pet.displayName;
  if (isDafeiyu(pet.package)) {
    if (saved === undefined) return '鲸鱼妹';
    if (/^大肥鱼(?:·分身)*$/.test(saved)) return saved.replace(/^大肥鱼/, '鲸鱼妹');
  }
  return saved ?? workspace?.catalog.find(entry => entry.id === pet.package.id && entry.version === pet.package.version)?.name ?? '未命名桌宠';
}
function draftOf(pet: PetDefinition, workspace: WorkspaceData): PetDraft {
  return { displayName: petDisplayName(pet, workspace), enabled: pet.enabled, autoStartOnLaunch: pet.autoStartOnLaunch, preferences: { ...pet.preferences } };
}
function sameDraft(a: PetDraft | undefined, b: PetDraft | undefined) {
  return !!a && !!b && a.displayName === b.displayName && a.enabled === b.enabled && a.autoStartOnLaunch === b.autoStartOnLaunch &&
    (['size', 'x', 'y', 'scheduledActivity', 'movement', 'hideInFullscreen'] as const).every(key => a.preferences[key] === b.preferences[key]);
}
export function isDraftDirty(state: PetWorkspaceState, id: string): boolean {
  const pet = state.workspace?.instances.find(item => item.id === id);
  return Object.hasOwn(state.drafts, id) && !!state.drafts[id] && (!pet || !sameDraft(state.drafts[id], draftOf(pet, state.workspace!)));
}

/** Single authority for local drafts and asynchronous request generations. No persistence here. */
export class PetWorkspaceController {
  private state: PetWorkspaceState = emptyPetState;
  private listeners = new Set<() => void>();
  private generation = 0;
  private refreshingRuntime = false;
  constructor(private bridge: PetsBridge | undefined) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<PetWorkspaceState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  private accept(workspace: WorkspaceData, saved?: { id: string; draft: PetDraft }) {
    const drafts: Record<string, PetDraft> = Object.create(null);
    for (const [id, draft] of Object.entries(this.state.drafts)) {
      if (isDraftDirty(this.state, id)) {
        const prior = this.state.workspace?.instances.find(pet => pet.id === id);
        const next = workspace.instances.find(pet => pet.id === id);
        const retained = { ...draft, preferences: { ...draft.preferences } };
        if (prior && next) {
          for (const key of ['x', 'y', 'size', 'hideInFullscreen', 'scheduledActivity', 'movement'] as const) {
            if (draft.preferences[key] === prior.preferences[key]) Object.assign(retained.preferences, { [key]: next.preferences[key] });
          }
        }
        drafts[id] = retained;
      }
    }
    for (const pet of workspace.instances) {
      const wasSaved = saved?.id === pet.id && sameDraft(this.state.drafts[pet.id], saved.draft);
      if (!Object.hasOwn(drafts, pet.id) || wasSaved) drafts[pet.id] = draftOf(pet, workspace);
    }
    this.update({ workspace, drafts, selectedId: this.state.selectedId && drafts[this.state.selectedId] ? this.state.selectedId : workspace.instances[0]?.id });
  }
  async load() {
    if (this.state.operation && this.state.operation !== 'load') return false;
    const generation = ++this.generation;
    this.update({ operation: 'load', error: undefined, notice: '' });
    const result = await requestPets(this.bridge, 'list');
    if (generation !== this.generation) return false;
    if (result.ok && (!this.state.workspace || result.workspace.revision >= this.state.workspace.revision)) {
      this.accept(result.workspace);
      this.update({ operation: undefined, needsRefresh: false, runtimeStale: false });
      return true;
    }
    this.update({ operation: undefined, error: result.ok ? 'conflict' : result.error, needsRefresh: result.ok || this.state.needsRefresh });
    return false;
  }
  async importPackages() {
    if (!this.canWrite() || !this.bridge) return false;
    const generation = ++this.generation;
    this.update({ operation: 'importPackages', error: undefined, notice: '' });
    const imported = await importPetPackages(this.bridge);
    if (generation !== this.generation) return false;
    if (!imported.ok) {
      this.update({ operation: undefined, error: imported.error });
      return false;
    }
    if (!imported.items.length) { this.update({ operation: undefined }); return true; }
    const result = await requestPets(this.bridge, 'list');
    if (generation !== this.generation) return false;
    if (!result.ok || result.workspace.revision < (this.state.workspace?.revision ?? 0)) {
      this.update({ operation: undefined, error: result.ok ? 'conflict' : result.error, needsRefresh: true });
      return false;
    }
    this.accept(result.workspace);
    const added = imported.items.filter(item => item.status === 'added').length;
    const failed = imported.items.length - added;
    this.update({ operation: undefined, needsRefresh: false, error: undefined, notice: `素材处理完成：成功 ${added} 项，失败 ${failed} 项。已导入素材目前不能启动播放器。` });
    return true;
  }
  async refreshRuntime() {
    if (this.refreshingRuntime || this.state.operation || this.state.needsRefresh || !this.state.workspace) return false;
    this.refreshingRuntime = true;
    const generation = this.generation;
    try {
      const result = await requestPets(this.bridge, 'list');
      if (generation !== this.generation || this.state.operation || this.state.needsRefresh) return false;
      if (!result.ok) { this.update({ runtimeStale: true }); return false; }
      if (result.workspace.revision < this.state.workspace!.revision) {
        this.update({ runtimeStale: true }); return false;
      }
      this.accept(result.workspace);
      this.update({ runtimeStale: false });
      return true;
    } finally { this.refreshingRuntime = false; }
  }
  async control(action: 'start' | 'stop') {
    if (!this.canWrite() || !this.state.selectedId) return false;
    const input = { expectedRevision: this.state.workspace!.revision, id: this.state.selectedId };
    return this.write(action, () => requestPets(this.bridge, action, input));
  }
  async controlLinkage(action: 'pause' | 'resume') {
    if (!this.canWrite()) return false;
    return this.write(action, () => requestPets(this.bridge, action, { expectedRevision: this.state.workspace!.revision }));
  }
  async applyDisplayPreferences() {
    if (!this.canWrite() || !this.state.selectedId) return false;
    const input = { expectedRevision: this.state.workspace!.revision, id: this.state.selectedId };
    return this.write('applyDisplay', () => requestPets(this.bridge, 'applyDisplay', input));
  }
  async applyBehaviorPreferences() {
    if (!this.canWrite() || !this.state.selectedId) return false;
    const input = { expectedRevision: this.state.workspace!.revision, id: this.state.selectedId };
    return this.write('applyBehavior', () => requestPets(this.bridge, 'applyBehavior', input));
  }
  async setVisible(visible: boolean) {
    if (!this.canWrite() || !this.state.selectedId) return false;
    const input = { expectedRevision: this.state.workspace!.revision, id: this.state.selectedId, visible };
    return this.write('visibility', () => requestPets(this.bridge, 'visibility', input));
  }
  select(id: string) {
    if (Object.hasOwn(this.state.drafts, id)) this.update({ selectedId: id, notice: '' });
  }
  edit(patch: Partial<PetDraft>) {
    const id = this.state.selectedId, draft = id && this.state.drafts[id];
    if (id && draft) this.update({ drafts: { ...this.state.drafts, [id]: { ...draft, ...patch } }, notice: '' });
  }
  discard() {
    const pet = this.state.workspace?.instances.find(item => item.id === this.state.selectedId);
    if (pet && !this.state.operation) this.update({ drafts: { ...this.state.drafts, [pet.id]: draftOf(pet, this.state.workspace!) }, notice: '已还原为最近读取的配置。', error: undefined });
  }
  private canWrite() { return !!this.state.workspace && !this.state.needsRefresh && (!this.state.operation || this.state.operation === 'load'); }
  private async write(action: keyof PetInputs, request: () => Promise<PetResult>, saved?: { id: string; draft: PetDraft }) {
    if (!this.canWrite()) return false;
    const generation = ++this.generation;
    const before = this.state.workspace!;
    const selectedAtStart = this.state.selectedId;
    this.update({ operation: action, error: undefined, notice: '' });
    const result = await request();
    if (generation !== this.generation) return false;
    if (!result.ok || result.workspace.revision < before.revision) {
      const error = result.ok ? 'conflict' : result.error;
      this.update({ operation: undefined, error, needsRefresh: error === 'conflict' || error === 'not-found' });
      if (action === 'pause' || action === 'resume') void this.load();
      return false;
    }
    this.accept(result.workspace, saved);
    if ((action === 'add' || action === 'clone') && this.state.selectedId === selectedAtStart) {
      const added = result.workspace.instances.find(pet => !before.instances.some(old => old.id === pet.id));
      if (added) this.update({ selectedId: added.id });
    }
    this.update({ operation: undefined, deleteId: action === 'delete' ? undefined : this.state.deleteId,
      runtimeStale: false,
      notice: action === 'pause' ? '暂停已确认；仅解除门禁不会自动启动实例。' : action === 'resume' ? '暂停门禁已解除；实例仍保持停止，需手动启动。' : action === 'start' ? (before.playerMode === 'video' ? '已请求启动视频实例；等待首帧确认。' : '已请求启动隔离开发实例；等待真实首帧确认，保存的显示偏好将在启动时应用。') : action === 'stop' ? (before.playerMode === 'video' ? '已请求停止视频实例；等待窗口关闭确认。' : '已请求停止自有实例；等待播放器与进程退出确认。') : action === 'applyDisplay' ? '播放器已确认应用当前保存的显示偏好。' : action === 'applyBehavior' ? '播放器已确认应用当前保存的行为偏好。' : action === 'visibility' ? '播放器已确认本会话显隐状态。' : action === 'theme' ? '界面主题已保存。' : action === 'delete' ? '已删除实例配置；素材与历史数据保持原样。' : action === 'save' ? '已保存。运行中的实例需单独应用显示或行为偏好。' : '配置已登记 · 待应用。不会启动桌宠。' });
    return true;
  }
  async save() {
    const state = this.state, id = state.selectedId, draft = id && state.drafts[id];
    if (!this.canWrite() || !id || !draft) return false;
    const input = { ...draft, id, expectedRevision: state.workspace!.revision };
    if (!isPetInput('save', input)) { this.update({ error: 'invalid' }); return false; }
    return this.write('save', () => requestPets(this.bridge, 'save', input), { id, draft });
  }
  async add(reference: PackageReference) {
    if (!this.canWrite()) return false;
    if (!this.state.workspace!.catalog.some(entry => entry.id === reference.id && entry.version === reference.version)) {
      this.update({ error: 'package-unavailable' }); return false;
    }
    const input = { expectedRevision: this.state.workspace!.revision, package: { id: reference.id, version: reference.version } };
    return this.write('add', () => requestPets(this.bridge, 'add', input));
  }
  async clone() {
    if (!this.canWrite() || !this.state.selectedId) return false;
    const input = { expectedRevision: this.state.workspace!.revision, id: this.state.selectedId };
    return this.write('clone', () => requestPets(this.bridge, 'clone', input));
  }
  requestDelete() { if (!this.state.operation && this.state.selectedId) this.update({ deleteId: this.state.selectedId }); }
  cancelDelete() { if (this.state.operation !== 'delete') this.update({ deleteId: undefined }); }
  async confirmDelete() {
    const id = this.state.deleteId;
    if (!this.canWrite() || !id) return false;
    const input = { expectedRevision: this.state.workspace!.revision, id };
    const success = await this.write('delete', () => requestPets(this.bridge, 'delete', input));
    if (success) {
      const drafts = { ...this.state.drafts }; delete drafts[id];
      this.update({ drafts, selectedId: this.state.selectedId === id ? this.state.workspace?.instances[0]?.id : this.state.selectedId });
    }
    return success;
  }
  async setTheme(theme: Theme) {
    if (!this.canWrite() || theme === this.state.workspace?.theme) return false;
    const input = { expectedRevision: this.state.workspace!.revision, theme };
    return this.write('theme', () => requestPets(this.bridge, 'theme', input));
  }
}
