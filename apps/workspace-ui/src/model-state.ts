import { isProbeReply, probeError, validProbeInput, type ModelProbeInput, type ModelProbeOperation, type ModelProbeReply } from '../../../packages/contracts/src/model-probe.ts';
import { validDiscoveryCandidate, type ModelCandidate, type ModelDiscoveryError, type ModelDiscoveryReply, type ModelDefault, type ModelDraft, type ModelEntry, type ModelProtocol, type ModelsBridge, type ModelWorkspaceReply, type SavedModelConfiguration, type SavedModelConnection } from '../../../packages/contracts/src/models.ts';

export const modelProtocols: Record<ModelProtocol, string> = {
  'chat-completions': 'Chat Completions', responses: 'OpenAI Responses', anthropic: 'Anthropic Messages', gemini: 'Gemini 原生 API',
};
export const modelPresets = {
  openai: { name: 'OpenAI', apiProtocol: 'responses', baseURL: 'https://api.openai.com/v1' },
  deepseek: { name: 'DeepSeek', apiProtocol: 'chat-completions', baseURL: 'https://api.deepseek.com/v1' },
  anthropic: { name: 'Anthropic', apiProtocol: 'anthropic', baseURL: 'https://api.anthropic.com/v1' },
  google: { name: 'Google Gemini', apiProtocol: 'gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta' },
  custom: { name: '自定义连接', apiProtocol: 'chat-completions', baseURL: '' },
} as const;

type DraftState = { edit: ModelDraft; expectedRevision: number; isNew: boolean; detach: boolean; proposedProtocol?: ModelProtocol };
type Operation = { kind: 'load' | 'save' | 'key' | 'default' | 'remove'; id?: string };
type Feedback = { text: string; id?: string; error?: boolean };
type Discovery = {
  id: string;
  operationID: string;
} & ({ kind: 'pending' } | { kind: 'error'; message: string } | {
  kind: 'candidates'; revision: number; candidates: ModelCandidate[]; truncated: boolean; selected: ReadonlySet<string>;
});
export type ConnectionTest = { input: ModelProbeOperation } & ({ kind: 'confirm' | 'pending' } | { kind: 'result'; result: ModelProbeReply });
export type ModelWorkspaceState = {
  discovery?: Discovery;
  connectionTest?: ConnectionTest;
  configuration?: SavedModelConfiguration;
  drafts: ReadonlyMap<string, DraftState>;
  expanded: ReadonlySet<string>;
  expandedModels: ReadonlyMap<string, ReadonlySet<string>>;
  needsRefresh: boolean;
  requiresRestart: boolean;
  operation?: Operation;
  feedback?: Feedback;
};
const discoveryMessages: Record<ModelDiscoveryError, string> = {
  invalid_configuration: '此连接无法获取模型列表，请核对已保存的配置。',
  configuration_conflict: '已保存的连接版本已改变。请重新读取；现有草稿仍保留。',
  credentials_unavailable: '无法读取此连接的 Key。请核对已保存凭证和系统授权。',
  storage_unavailable: '无法读取隔离配置，请重新读取并核对。',
  publication_uncertain: '发布结果不确定。请重新读取核对，重启前不能获取模型列表。',
  busy: '已有模型操作在处理，请稍后再试。',
  authentication_failed: '模型列表接口拒绝了认证，请检查此连接的 Key 和地址。',
  rate_limited: '模型列表接口限制了请求频率，请稍后重试。',
  invalid_response: '模型列表内容无效，请手工添加模型。',
  response_too_large: '模型列表超出大小限制，请手工添加模型。',
  upstream_unavailable: '该地址的模型列表接口不可用，请核对地址或手工添加。',
  timed_out: '获取模型列表超时，可重试或手工添加。',
  cancelled: '已取消获取模型列表。',
  unavailable: '本地模型发现暂不可用。',
};
const messages: Record<Extract<ModelWorkspaceReply, { ok: false }>['error'], string> = {
  invalid_configuration: '配置未保存。请检查地址、默认模型及各模型的 ID 和字段。',
  configuration_conflict: '已保存的配置发生了变化。请重新读取；草稿仍保留。',
  credentials_unavailable: '无法保存凭证。原有配置和凭证未被替换。',
  storage_unavailable: '无法访问隔离配置。请重新读取；不会以空配置覆盖原文件。',
  publication_uncertain: '无法确认配置是否已发布。可以重新读取，核对磁盘版本；本次服务重启前不会再写入。',
  write_outcome_unknown: '未收到保存结果。请重新读取，核对已保存的版本。',
  busy: '已有配置操作在处理，请稍后再试。', unavailable: '本地模型管理暂不可用。',
  key_input_cancelled: '已取消凭证保存，草稿仍保留。', key_input_expired: '凭证操作已超时，请重新准备。',
  clipboard_not_key: '剪贴板中没有可用的单行 API Key。请重新复制后再试。',
};
export const emptyModelState: ModelWorkspaceState = { drafts: new Map(), expanded: new Set(), expandedModels: new Map(), needsRefresh: false, requiresRestart: false };
const toDraft = ({ revision, credentialState: _status, ...edit }: SavedModelConnection): DraftState => ({ edit: structuredClone(edit), expectedRevision: revision, isNew: false, detach: false });
const newEntry = (entryID: string): ModelEntry => ({ entryID, modelID: '', displayName: '', compatibility: {}, capabilities: { tools: { status: 'unknown', source: 'user' } } });
const flip = (list: ReadonlySet<string>, id: string) => { const next = new Set(list); if (next.has(id)) next.delete(id); else next.add(id); return next; };
const apiRoot = (value: string) => { try { const url = new URL(value); return `${url.origin}${url.pathname.replace(/\/+$/, '')}`; } catch { return value; } };
export function keyNeedsDecision(draft: DraftState, saved?: SavedModelConnection): boolean {
  return saved?.credentialState === 'reference-present' && (draft.edit.authMode !== 'apiKey' || draft.edit.apiProtocol !== saved.apiProtocol || apiRoot(draft.edit.baseURL) !== apiRoot(saved.baseURL));
}

export class ModelWorkspaceController {
  private state = emptyModelState;
  private readonly listeners = new Set<() => void>();
  private requested = false;
  private cancellationSent = false;
  constructor(private readonly bridge?: ModelsBridge, private readonly makeID: () => string = () => crypto.randomUUID()) {}
  get available(): boolean { return !!this.bridge; }
  getSnapshot = (): ModelWorkspaceState => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<ModelWorkspaceState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  private saved(id: string) { return this.state.configuration?.connections.find(item => item.id === id); }
  private canWrite() { return !!this.bridge && !!this.state.configuration && !this.state.operation && !this.state.needsRefresh && !this.state.requiresRestart; }
  open(): void { if (!this.requested) void this.load(); }
  leave(): void {
    this.cancelDiscovery();
    this.cancelConnectionTest();
    if (this.state.operation?.kind !== 'key' || this.cancellationSent) return;
    this.cancellationSent = true;
    void this.bridge?.cancelKeySave().catch(() => { this.cancellationSent = false; });
  }
  async load(): Promise<void> {
    if (!this.bridge || this.state.operation) return;
    this.requested = true;
    await this.perform({ kind: 'load' }, () => this.bridge!.list());
  }
  edit(id: string): void {
    const saved = this.saved(id);
    if (!saved || !this.canWrite()) return;
    if (!this.state.drafts.has(id)) this.storeDraft(id, toDraft(saved));
    this.update({ expanded: new Set(this.state.expanded).add(id) });
  }
  add(preset: ModelDraft['preset']): string | undefined {
    if (!this.canWrite() || this.state.configuration!.connections.length + [...this.state.drafts.values()].filter(draft => draft.isNew).length >= 32) return;
    const id = this.makeID(), entry = newEntry(this.makeID());
    const { name, apiProtocol, baseURL } = modelPresets[preset];
    this.storeDraft(id, { isNew: true, expectedRevision: 0, detach: false, edit: {
      id, displayName: name, preset, apiProtocol, baseURL, authMode: 'apiKey', models: [entry], defaultModelEntryID: entry.entryID, compatibility: {},
    } });
    this.update({ expanded: new Set(this.state.expanded).add(id), expandedModels: new Map(this.state.expandedModels).set(id, new Set([entry.entryID])) });
    return id;
  }
  toggleConnection(id: string): void {
    if (this.state.expanded.has(id)) this.cancelDiscovery(id);
    if (this.state.expanded.has(id) && this.state.operation?.kind === 'key' && this.state.operation.id === id) this.leave();
    this.update({ expanded: flip(this.state.expanded, id) });
  }
  toggleModel(id: string, entry: string): void {
    this.update({ expandedModels: new Map(this.state.expandedModels).set(id, flip(this.state.expandedModels.get(id) ?? new Set(), entry)) });
  }
  stale(id: string): boolean {
    const draft = this.state.drafts.get(id), saved = this.saved(id);
    return !!draft && (draft.isNew ? !!saved : !saved || saved.revision !== draft.expectedRevision);
  }
  reloadDraft(id: string): void { const saved = this.saved(id); if (saved && this.canWrite()) this.storeDraft(id, toDraft(saved)); }
  cancel(id: string): void {
    if (this.state.operation || !this.state.drafts.has(id)) return;
    this.cancelDiscovery(id);
    this.cancelConnectionTest(id);
    const drafts = new Map(this.state.drafts); drafts.delete(id);
    const expanded = new Set(this.state.expanded), expandedModels = new Map(this.state.expandedModels);
    if (!this.saved(id)) { expanded.delete(id); expandedModels.delete(id); }
    else {
      const entryIDs = new Set(this.saved(id)!.models.map(model => model.entryID));
      expandedModels.set(id, new Set([...(expandedModels.get(id) ?? [])].filter(entry => entryIDs.has(entry))));
    }
    this.update({ drafts, expanded, expandedModels, ...(this.state.feedback?.id === id ? { feedback: undefined } : {}) });
  }
  private storeDraft(id: string, draft: DraftState): void {
    this.cancelDiscovery(id);
    this.cancelConnectionTest(id);
    this.update({ drafts: new Map(this.state.drafts).set(id, draft) });
  }
  private change(id: string, modify: (draft: DraftState) => DraftState): void {
    const draft = this.state.drafts.get(id);
    if (draft && !this.state.operation && !this.stale(id)) this.storeDraft(id, modify(draft));
  }
  patch(id: string, fields: Partial<Pick<ModelDraft, 'displayName' | 'preset' | 'baseURL' | 'authMode' | 'compatibility' | 'defaultModelEntryID'>>): void {
    this.change(id, draft => ({ ...draft, edit: { ...draft.edit, ...fields } }));
  }
  patchEntry(id: string, entry: string, fields: Partial<Omit<ModelEntry, 'entryID'>>): void {
    this.change(id, draft => ({ ...draft, edit: { ...draft.edit, models: draft.edit.models.map(model => model.entryID === entry ? { ...model, ...fields, entryID: model.entryID } : model) } }));
  }
  addEntry(id: string): void {
    const draft = this.state.drafts.get(id);
    if (!draft || draft.edit.models.length >= 33 || this.state.operation || this.stale(id)) return;
    const item = newEntry(this.makeID());
    this.change(id, value => ({ ...value, edit: { ...value.edit, models: [...value.edit.models, item] } }));
    this.toggleModel(id, item.entryID);
  }
  removeEntry(id: string, entry: string, replacement?: string): void {
    const before = this.state.drafts.get(id);
    this.change(id, draft => {
      const models = draft.edit.models.filter(model => model.entryID !== entry);
      const defaultModelEntryID = draft.edit.defaultModelEntryID === entry ? replacement : draft.edit.defaultModelEntryID;
      return defaultModelEntryID && models.some(model => model.entryID === defaultModelEntryID) ? { ...draft, edit: { ...draft.edit, models, defaultModelEntryID } } : draft;
    });
    if (before !== this.state.drafts.get(id) && this.state.expandedModels.get(id)?.has(entry)) this.toggleModel(id, entry);
  }
  changeProtocol(id: string, protocol: ModelProtocol): void {
    this.change(id, draft => protocol !== 'chat-completions' && (draft.edit.compatibility.outputTokenField || draft.edit.models.some(model => model.compatibility.outputTokenField))
      ? { ...draft, proposedProtocol: protocol } : { ...draft, proposedProtocol: undefined, edit: { ...draft.edit, apiProtocol: protocol } });
  }
  confirmProtocol(id: string): void {
    this.change(id, draft => !draft.proposedProtocol ? draft : { ...draft, proposedProtocol: undefined, edit: {
      ...draft.edit, apiProtocol: draft.proposedProtocol, compatibility: {}, models: draft.edit.models.map(model => ({ ...model, compatibility: {} })),
    } });
  }
  cancelProtocol(id: string): void { this.change(id, draft => ({ ...draft, proposedProtocol: undefined })); }
  detachKey(id: string, detach: boolean): void { this.change(id, draft => ({ ...draft, detach })); }
  async save(id: string, useClipboard = false): Promise<void> {
    const draft = this.state.drafts.get(id);
    if (!draft || !this.canWrite() || this.stale(id) || draft.proposedProtocol) return;
    const { edit, expectedRevision } = draft;
    if (!edit.displayName.trim() || !edit.baseURL.trim() || edit.models.some(model => !model.displayName.trim() || !model.modelID.trim())) {
      this.update({ feedback: { id, error: true, text: '请填写连接名称、接入地址和每个模型的名称及 API ID。' } }); return;
    }
    if (useClipboard ? edit.authMode !== 'apiKey' || draft.detach : keyNeedsDecision(draft, this.saved(id)) && !draft.detach) {
      this.update({ feedback: { id, error: true, text: '地址、协议或鉴权已变更。请明确解除旧凭证绑定，或用新 Key 保存。' } }); return;
    }
    const input = { connection: edit, expectedRevision };
    await this.perform({ kind: useClipboard ? 'key' : 'save', id }, () => useClipboard
      ? this.bridge!.prepareKeySave(input) : this.bridge!.save({ ...input, credential: { kind: draft.detach ? 'remove' : 'keep' } }));
  }
  async setDefault(id: string | null, entry?: string): Promise<void> {
    if (!this.canWrite()) return;
    const expectedRevision = this.state.configuration!.revision;
    const saved = id === null ? undefined : this.saved(id);
    if (id !== null && !saved) return;
    const entryID = entry ?? saved?.defaultModelEntryID;
    if (id !== null && (!entryID || !saved?.models.some(model => model.entryID === entryID))) return;
    const input: ModelDefault = id === null ? { expectedRevision, connectionID: null } : { expectedRevision, connectionID: id, entryID: entryID! };
    await this.perform({ kind: 'default', id: id ?? undefined }, () => this.bridge!.setDefault(input));
  }
  async remove(id: string, replacementDefault?: string | null): Promise<void> {
    const saved = this.saved(id);
    if (!this.canWrite() || !saved) return;
    const { defaultConnectionID } = this.state.configuration!;
    const expectedRevision = saved.revision;
    if (defaultConnectionID === id ? replacementDefault === undefined || (replacementDefault !== null && (replacementDefault === id || !this.saved(replacementDefault))) : replacementDefault !== undefined) return;
    await this.perform({ kind: 'remove', id }, () => this.bridge!.remove({ connectionID: id, expectedRevision, ...(replacementDefault === undefined ? {} : { replacementDefault }) }));
  }
  discoveryBlockedReason(id: string): string | undefined {
    const saved = this.saved(id), draft = this.state.drafts.get(id);
    if (!this.bridge?.discover || !this.bridge.cancelDiscovery) return '此工作区未接入模型发现。';
    if (!saved) return '请先保存连接，再获取列表。';
    if (this.stale(id) || this.state.needsRefresh || this.state.requiresRestart) return '请先核对已保存的连接版本。';
    if (draft && (draft.detach || draft.proposedProtocol || draft.edit.baseURL !== saved.baseURL ||
        draft.edit.apiProtocol !== saved.apiProtocol || draft.edit.authMode !== saved.authMode)) return '请先保存地址、协议和凭证变更，再获取列表。';
    if (saved.credentialState === 'missing') return '此连接尚未保存 API Key。';
    if (this.state.operation || this.state.discovery?.kind === 'pending' || this.state.connectionTest?.kind === 'pending') return '已有模型操作在处理。';
    return undefined;
  }
  private testInput(id: string): ModelProbeInput | undefined {
    const saved = this.saved(id), connection = this.state.drafts.get(id)?.edit ?? saved;
    const entry = connection?.models.find(item => item.entryID === connection.defaultModelEntryID);
    if (!saved || !connection || !entry) return;
    const input = { connectionID: id, expectedRevision: saved.revision, entryID: entry.entryID, modelID: entry.modelID,
      ...(entry.maxOutputTokens === undefined ? {} : { maxOutputTokens: entry.maxOutputTokens }),
      ...connection.compatibility, ...entry.compatibility };
    return validProbeInput(input) ? input : undefined;
  }
  connectionTestBlockedReason(id: string): string | undefined {
    const saved = this.saved(id), draft = this.state.drafts.get(id);
    if (!this.bridge?.testConnection || !this.bridge.cancelConnectionTest) return '此工作区未接入连接测试。';
    if (!saved) return '请先保存连接，再测试。';
    if (this.stale(id) || this.state.needsRefresh || this.state.requiresRestart) return '请先核对已保存的连接版本。';
    if (draft && (draft.detach || draft.proposedProtocol || draft.edit.baseURL !== saved.baseURL ||
        draft.edit.apiProtocol !== saved.apiProtocol || draft.edit.authMode !== saved.authMode)) return '请先保存地址、协议或凭证变更，再测试。';
    if (saved.credentialState === 'missing') return '请先保存此连接的 API Key，再测试。';
    if (!this.testInput(id)) return '请填写有效的连接默认模型 API ID 和输出设置。';
    if (this.state.operation || this.state.discovery?.kind === 'pending' || this.state.connectionTest?.kind === 'pending') return '已有模型操作在处理。';
  }
  prepareConnectionTest(id: string): void {
    if (this.connectionTestBlockedReason(id)) return;
    this.update({ connectionTest: { kind: 'confirm', input: { ...this.testInput(id)!, operationID: this.makeID() } } });
  }
  async confirmConnectionTest(id: string): Promise<void> {
    const current = this.state.connectionTest;
    if (current?.kind !== 'confirm' || current.input.connectionID !== id || this.connectionTestBlockedReason(id)) return;
    const { operationID, ...input } = current.input;
    if (JSON.stringify(input) !== JSON.stringify(this.testInput(id))) { this.cancelConnectionTest(id); return; }
    const pending = { kind: 'pending', input: current.input } as const;
    this.update({ connectionTest: pending });
    let result: ModelProbeReply;
    try { const reply = await this.bridge!.testConnection!(pending.input); result = isProbeReply(reply, input) ? reply : probeError('unavailable'); }
    catch { result = probeError('unavailable'); }
    if (this.state.connectionTest !== pending || this.saved(id)?.revision !== input.expectedRevision) return;
    this.update({ connectionTest: { kind: 'result', input: pending.input, result } });
  }
  cancelConnectionTest(id?: string, showCancellation = false): void {
    const current = this.state.connectionTest;
    if (!current || id !== undefined && id !== current.input.connectionID) return;
    this.update({ connectionTest: showCancellation && current.kind === 'pending'
      ? { kind: 'result', input: current.input, result: probeError('cancelled') } : undefined });
    if (current.kind === 'pending') void this.bridge?.cancelConnectionTest?.(current.input.operationID).catch(() => {});
  }
  async discover(id: string): Promise<void> {
    if (this.discoveryBlockedReason(id)) return;
    const saved = this.saved(id)!, draft = this.state.drafts.get(id);
    const pending = { kind: 'pending', id, operationID: this.makeID() } as const;
    this.update({ discovery: pending });
    let result: ModelDiscoveryReply;
    try { result = await this.bridge!.discover!({ connectionID: id, expectedRevision: saved.revision, operationID: pending.operationID }); }
    catch { result = { version: 1, ok: false, error: 'unavailable' }; }
    if (this.state.discovery !== pending || this.saved(id)?.revision !== saved.revision || this.state.drafts.get(id) !== draft) return;
    if (!result.ok || result.connectionID !== id || result.revision !== saved.revision || result.candidates.length > 256 || !result.candidates.every(validDiscoveryCandidate)) {
      const error = result.ok ? 'invalid_response' : result.error;
      this.update({ discovery: { ...pending, kind: 'error', message: discoveryMessages[error] },
        needsRefresh: this.state.needsRefresh || error === 'configuration_conflict' || error === 'storage_unavailable',
        requiresRestart: this.state.requiresRestart || error === 'publication_uncertain' });
      return;
    }
    this.update({ discovery: { ...pending, kind: 'candidates', revision: saved.revision, truncated: result.truncated, candidates: result.candidates, selected: new Set() } });
  }
  cancelDiscovery(id?: string): void {
    const current = this.state.discovery;
    if (!current || (id !== undefined && current.id !== id)) return;
    this.update({ discovery: undefined });
    if (current.kind === 'pending') void this.bridge?.cancelDiscovery?.(current.operationID).catch(() => {});
  }
  toggleCandidate(id: string, modelID: string): void {
    const current = this.state.discovery, models = this.state.drafts.get(id)?.edit.models ?? this.saved(id)?.models;
    if (current?.kind !== 'candidates' || current.id !== id || !models || models.some(item => item.modelID === modelID) ||
        !current.candidates.some(item => item.modelID === modelID)) return;
    this.update({ discovery: { ...current, selected: flip(current.selected, modelID) } });
  }
  mergeCandidates(id: string): void {
    const current = this.state.discovery, saved = this.saved(id);
    if (current?.kind !== 'candidates' || current.id !== id || saved?.revision !== current.revision || this.discoveryBlockedReason(id)) return;
    const draft = this.state.drafts.get(id) ?? toDraft(saved), used = new Set(draft.edit.models.map(item => item.modelID));
    const additions = current.candidates.filter(item => {
      if (!current.selected.has(item.modelID) || used.has(item.modelID)) return false;
      used.add(item.modelID); return true;
    });
    if (!additions.length || draft.edit.models.length + additions.length > 33) return;
    const entries: ModelEntry[] = additions.map(candidate => ({ ...newEntry(this.makeID()), ...candidate, capabilities: { tools: { status: 'unknown', source: 'discovery' } } }));
    this.storeDraft(id, { ...draft, edit: { ...draft.edit, models: [...draft.edit.models, ...entries] } });
    this.update({ feedback: { id, text: `已将 ${entries.length} 个模型加入草稿，保存配置后才会写入。` } });
  }
  private async perform(operation: Operation, run: () => Promise<ModelWorkspaceReply>): Promise<void> {
    this.cancelDiscovery();
    this.cancelConnectionTest();
    if (operation.kind === 'key') this.cancellationSent = false;
    this.update({ operation, feedback: undefined });
    let result: ModelWorkspaceReply;
    try { result = await run(); }
    catch { result = { version: 1, ok: false, error: operation.kind === 'load' ? 'unavailable' : 'write_outcome_unknown' }; }
    const { kind, id } = operation;
    if (!result.ok) {
      const cleanup = 'credentialCleanup' in result ? result.credentialCleanup : undefined;
      const suffix = cleanup === 'pending' || cleanup === 'retained_uncertain' ? ' 无法确认新凭证是否已清理。' : '';
      this.update({ operation: undefined, needsRefresh: kind === 'load' || ['storage_unavailable', 'configuration_conflict', 'publication_uncertain', 'write_outcome_unknown'].includes(result.error),
        requiresRestart: this.state.requiresRestart || result.error === 'publication_uncertain',
        feedback: { id, text: messages[result.error] + suffix, error: result.error !== 'key_input_cancelled' } });
      return;
    }
    const drafts = new Map(this.state.drafts);
    if (id && (kind === 'save' || kind === 'key' || kind === 'remove')) drafts.delete(id);
    const note = kind === 'remove' ? '连接已从本地配置移除。' : kind === 'default' ? '已更新本地默认值。' : '已保存本地配置，尚未测试连接。';
    const durability = result.durability === 'unconfirmed' ? ' 文件发布后未确认磁盘同步，请重新读取核对。' : '';
    const retained = result.retainedCredentialVersions ? ' 旧凭证条目仍保留。' : '';
    const known = new Map(result.configuration.connections.map(connection => [connection.id, connection.models]));
    for (const [id, draft] of drafts) known.set(id, draft.edit.models);
    const expanded = new Set([...this.state.expanded].filter(id => known.has(id)));
    const expandedModels = new Map([...this.state.expandedModels].flatMap(([id, items]) => {
      const entries = known.get(id);
      if (!entries) return [];
      const entryIDs = new Set(entries.map(item => item.entryID));
      return [[id, new Set([...items].filter(entry => entryIDs.has(entry)))]] as const;
    }));
    this.update({ configuration: result.configuration, drafts, expanded, expandedModels, needsRefresh: !!durability,
      requiresRestart: this.state.requiresRestart || result.writesBlocked === true, operation: undefined,
      feedback: kind === 'load' ? undefined : { id: kind === 'remove' ? undefined : id, text: note + durability + retained } });
  }
}
