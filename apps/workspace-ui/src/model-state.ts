import { validProbeRecord, isProbeReply, isRecordedProbeFailure, probeError, validProbeInput, type ModelProbeInput, type ModelProbeOperation, type ModelProbeReply } from '../../../packages/contracts/src/model-probe.ts';
import { normalizeModelBaseURL, validDiscoveryCandidate, validModelAPIKey, type ModelCandidate, type ModelDiscoveryError, type ModelDiscoveryReply, type ModelDefault, type ModelDraft, type ModelEntry, type ModelProtocol, type ModelsBridge, type ModelWorkspaceReply, type SavedModelConfiguration, type SavedModelConnection } from '../../../packages/contracts/src/models.ts';

export const modelProtocols: Record<ModelProtocol, string> = {
  'chat-completions': 'Chat Completions', responses: 'OpenAI Responses', anthropic: 'Anthropic Messages', gemini: 'Gemini 原生 API',
};
export const modelPresets = {
  openai: { name: 'OpenAI', apiProtocol: 'responses', baseURL: 'https://api.openai.com/v1' },
  deepseek: { name: 'DeepSeek', apiProtocol: 'chat-completions', baseURL: 'https://api.deepseek.com/v1' },
  anthropic: { name: 'Anthropic', apiProtocol: 'anthropic', baseURL: 'https://api.anthropic.com/v1' },
  google: { name: 'Google Gemini', apiProtocol: 'gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta' },
  custom: { name: '自定义模型 API', apiProtocol: 'chat-completions', baseURL: '' },
} as const;

export const modelProviderTemplates = {
  openai: { ...modelPresets.openai, preset: 'openai', apiProtocol: 'chat-completions' },
  deepseek: { ...modelPresets.deepseek, preset: 'deepseek' },
  anthropic: { ...modelPresets.anthropic, name: 'Anthropic Claude', preset: 'anthropic' },
  google: { ...modelPresets.google, preset: 'google', apiProtocol: 'chat-completions', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  qwen: { name: '阿里云百炼 · 通义千问', preset: 'custom', apiProtocol: 'chat-completions', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  moonshot: { name: '月之暗面 · Kimi', preset: 'custom', apiProtocol: 'chat-completions', baseURL: 'https://api.moonshot.cn/v1' },
  zhipu: { name: '智谱 · GLM', preset: 'custom', apiProtocol: 'chat-completions', baseURL: 'https://open.bigmodel.cn/api/paas/v4' },
  minimax: { name: 'MiniMax', preset: 'custom', apiProtocol: 'chat-completions', baseURL: 'https://api.minimax.io/v1' },
} as const;
export type ModelProviderTemplate = keyof typeof modelProviderTemplates;

type DraftState = { edit: ModelDraft; expectedRevision: number; isNew: boolean; detach: boolean; provider?: ModelProviderTemplate; proposedProtocol?: ModelProtocol };
type Operation = { kind: 'load' | 'save' | 'default' | 'remove' | 'remove-entry'; id?: string };
type Feedback = { text: string; id?: string; error?: boolean };
type Discovery = {
  id: string;
  operationID: string;
} & ({ kind: 'pending' } | { kind: 'error'; message: string } | {
  kind: 'candidates'; revision: number; candidates: ModelCandidate[]; truncated: boolean; selected: ReadonlySet<string>;
});
export type ConnectionTest = { input: ModelProbeOperation } & ({ kind: 'confirm' | 'pending'; explicitEntry?: boolean } | { kind: 'result'; result: ModelProbeReply });
export const probeResultKey = (id: string, entry: string) => JSON.stringify([id, entry]);
export type ModelWorkspaceState = {
  discovery?: Discovery;
  connectionTest?: ConnectionTest;
  probeStorageUnavailable?: true;
  probeResults?: ReadonlyMap<string, Extract<ConnectionTest, { kind: 'result' }>>;
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
};
export const emptyModelState: ModelWorkspaceState = { drafts: new Map(), expanded: new Set(), expandedModels: new Map(), needsRefresh: false, requiresRestart: false };
const toDraft = ({ revision, credentialState: _status, ...edit }: SavedModelConnection): DraftState => ({ edit: structuredClone(edit), expectedRevision: revision, isNew: false, detach: false });
const newEntry = (entryID: string): ModelEntry => ({ entryID, modelID: '', displayName: '', compatibility: {}, capabilities: { tools: { status: 'unknown', source: 'user' } } });
const clearRouteMetadata = (model: ModelEntry): ModelEntry => ({ ...model, reasoningEffort: undefined, inputModalities: undefined,
  capabilities: { tools: { status: 'unknown', source: 'user' } } });
const flip = (list: ReadonlySet<string>, id: string) => { const next = new Set(list); if (next.has(id)) next.delete(id); else next.add(id); return next; };
const apiRoot = (value: string) => { try { const url = new URL(value); return `${url.origin}${url.pathname.replace(/\/+$/, '')}`; } catch { return value; } };
export function keyNeedsDecision(draft: DraftState, saved?: SavedModelConnection): boolean {
  return saved?.credentialState === 'reference-present' && (draft.edit.apiProtocol !== saved.apiProtocol || apiRoot(draft.edit.baseURL) !== apiRoot(saved.baseURL));
}

export class ModelWorkspaceController {
  private state = emptyModelState;
  private readonly listeners = new Set<() => void>();
  private visibilityGeneration = 0;
  constructor(private readonly bridge?: ModelsBridge, private readonly makeID: () => string = () => crypto.randomUUID()) {}
  get canTest(): boolean { return !!this.bridge?.testConnection && !!this.bridge.cancelConnectionTest; }
  get available(): boolean { return !!this.bridge; }
  getSnapshot = (): ModelWorkspaceState => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<ModelWorkspaceState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  private saved(id: string) { return this.state.configuration?.connections.find(item => item.id === id); }
  private canWrite() { return !!this.bridge && !!this.state.configuration && !this.state.operation && !this.state.needsRefresh && !this.state.requiresRestart; }
  open(): Promise<void> { return this.load(); }
  leave(): void {
    this.visibilityGeneration++;
    this.cancelDiscovery();
    this.cancelConnectionTest();
  }
  async load(): Promise<void> {
    if (!this.bridge || this.state.operation) return;
    await this.perform({ kind: 'load' }, () => this.bridge!.list());
  }
  edit(id: string): void {
    const saved = this.saved(id);
    if (!saved || !this.canWrite()) return;
    if (!this.state.drafts.has(id)) this.storeDraft(id, toDraft(saved));
    this.update({ expanded: new Set(this.state.expanded).add(id) });
  }
  add(preset: ModelDraft['preset'], alternativeDraftID?: string): string | undefined {
    if (!this.canWrite() || this.state.configuration!.connections.length + [...this.state.drafts.values()]
      .filter(draft => draft.isNew && draft.edit.id !== alternativeDraftID).length >= 32) return;
    const id = this.makeID(), entry = newEntry(this.makeID());
    const { name, apiProtocol, baseURL } = modelPresets[preset];
    this.storeDraft(id, { isNew: true, expectedRevision: 0, detach: false, edit: {
      id, displayName: name, preset, apiProtocol, baseURL, authMode: 'apiKey', models: [entry], defaultModelEntryID: entry.entryID, compatibility: {},
    } });
    this.update({ expanded: new Set(this.state.expanded).add(id), expandedModels: new Map(this.state.expandedModels).set(id, new Set([entry.entryID])) });
    return id;
  }
  selectProvider(id: string, provider: ModelProviderTemplate): void {
    const template = modelProviderTemplates[provider];
    this.change(id, draft => !draft.isNew || draft.provider === provider ? draft : { ...draft, provider, proposedProtocol: undefined, edit: {
      ...draft.edit, displayName: template.name, preset: template.preset, apiProtocol: template.apiProtocol,
      baseURL: template.baseURL, authMode: 'apiKey', compatibility: {},
      models: [newEntry(draft.edit.defaultModelEntryID)],
    } });
  }
  toggleConnection(id: string): void {
    if (this.state.expanded.has(id)) this.cancelDiscovery(id);
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
  patch(id: string, fields: Partial<Pick<ModelDraft, 'displayName' | 'preset' | 'baseURL' | 'compatibility' | 'defaultModelEntryID'>>): void {
    this.change(id, draft => ({ ...draft, edit: { ...draft.edit, ...fields,
      ...(fields.baseURL !== undefined && apiRoot(fields.baseURL) !== apiRoot(draft.edit.baseURL)
        ? { models: draft.edit.models.map(clearRouteMetadata) }
        : {}) } }));
  }
  patchEntry(id: string, entry: string, fields: Partial<Omit<ModelEntry, 'entryID'>>): void {
    this.change(id, draft => ({ ...draft, edit: { ...draft.edit, models: draft.edit.models.map(model => {
      if (model.entryID !== entry) return model;
      const identityChanged = fields.modelID !== undefined && fields.modelID !== model.modelID;
      const next = { ...model, ...fields, entryID: model.entryID };
      return identityChanged ? clearRouteMetadata(next) : next;
    }) } }));
  }
  addEntry(id: string): string | undefined {
    const draft = this.state.drafts.get(id);
    if (!draft || draft.edit.models.length >= 33 || this.state.operation || this.stale(id)) return;
    const item = newEntry(this.makeID());
    this.change(id, value => ({ ...value, edit: { ...value.edit, models: [...value.edit.models, item] } }));
    this.toggleModel(id, item.entryID);
    return item.entryID;
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
    this.change(id, draft => {
      const needsCompatibilityConfirmation = protocol !== 'chat-completions' &&
        !!(draft.edit.compatibility.outputTokenField || draft.edit.models.some(model => model.compatibility.outputTokenField));
      if (needsCompatibilityConfirmation) return { ...draft, proposedProtocol: protocol };
      return { ...draft, proposedProtocol: undefined, edit: { ...draft.edit, apiProtocol: protocol,
        ...(protocol !== draft.edit.apiProtocol ? { models: draft.edit.models.map(clearRouteMetadata) } : {}) } };
    });
  }
  confirmProtocol(id: string): void {
    this.change(id, draft => !draft.proposedProtocol ? draft : { ...draft, proposedProtocol: undefined, edit: {
      ...draft.edit, apiProtocol: draft.proposedProtocol, compatibility: {}, models: draft.edit.models.map(model => ({ ...clearRouteMetadata(model), compatibility: {} })),
    } });
  }
  cancelProtocol(id: string): void { this.change(id, draft => ({ ...draft, proposedProtocol: undefined })); }
  detachKey(id: string, detach: boolean): void { this.change(id, draft => ({ ...draft, detach })); }
  async save(id: string, apiKey = '', testAfterSave?: readonly string[], onSubmit?: () => void): Promise<boolean> {
    const draft = this.state.drafts.get(id);
    if (!draft || !this.canWrite() || this.stale(id) || draft.proposedProtocol) return false;
    const { edit, expectedRevision } = draft;
    const fail = (text: string) => { this.update({ feedback: { id, error: true, text } }); return false; };
    if (!edit.displayName.trim()) return fail('请填写服务商名称。');
    if (!normalizeModelBaseURL(edit.baseURL, edit.apiProtocol)) return fail('请填写有效的接口地址（远程用 HTTPS，本机可用 HTTP 回环）。');
    if (edit.models.some(model => !model.displayName.trim() || !model.modelID.trim() || /\s/u.test(model.modelID))) return fail('请填写模型名称和 API ID；API ID 不应包含空白。');
    if (edit.models.some(model => model.contextWindow !== undefined && (!Number.isInteger(model.contextWindow) || model.contextWindow < 1 || model.contextWindow > 2147483647))) {
      return fail('上下文窗口应为有效的正整数容量，或留空。');
    }
    if (apiKey && (!validModelAPIKey(apiKey) || draft.detach)) {
      this.update({ feedback: { id, error: true, text: '请输入有效的单行 API Key，不含空格。' } }); return false;
    }
    const saved = this.saved(id);
    if (!apiKey && keyNeedsDecision(draft, saved) && !draft.detach) {
      this.update({ feedback: { id, error: true, text: '地址或协议已变更。请输入新 Key，或解除旧绑定后无 Key 保存。' } }); return false;
    }
    // Keep untouched legacy loopback bindings readable without invalidating their route identity.
    // The schema-v2 apiKey value also represents connections with no credential reference.
    const connection = edit.authMode === 'none' && (apiKey || apiRoot(edit.baseURL) !== apiRoot(saved?.baseURL ?? ''))
      ? { ...edit, authMode: 'apiKey' as const } : edit;
    const generation = this.visibilityGeneration;
    const published = await this.perform({ kind: 'save', id }, () => {
      onSubmit?.(); // Clear the uncontrolled input at dispatch, not on a local validation error.
      return this.bridge!.save({ connection, expectedRevision,
        credential: apiKey ? { kind: 'replace', key: apiKey } : { kind: draft.detach ? 'remove' : 'keep' },
      });
    });
    apiKey = ''; // Do not retain the submitted value while a post-save probe runs.
    if (published && testAfterSave?.length) {
      const revision = this.saved(id)?.revision;
      let started = false;
      for (const entry of new Set(testAfterSave)) {
        if (generation !== this.visibilityGeneration || this.saved(id)?.revision !== revision || this.connectionTestBlockedReason(id, entry)) break;
        this.prepareConnectionTest(id, entry);
        started = true;
        const outcome = await this.confirmConnectionTest(id);
        if (!outcome?.ok) break; // Stop when a result cannot be confirmed; never retry on its own.
      }
      const feedback = this.state.feedback;
      if (started && feedback?.id === id && !feedback.error) this.update({ feedback: { ...feedback,
        text: feedback.text.replace('已保存本地配置，尚未测试连接。', '已保存本地配置，测试状态见服务商列表。'),
      } });
    }
    return published;
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
  async remove(id: string, replacementDefault?: string | null): Promise<boolean> {
    const saved = this.saved(id);
    if (!this.canWrite() || !saved) return false;
    const { defaultConnectionID } = this.state.configuration!;
    const expectedRevision = saved.revision;
    if (defaultConnectionID === id ? replacementDefault === undefined || (replacementDefault !== null && (replacementDefault === id || !this.saved(replacementDefault))) : replacementDefault !== undefined) return false;
    return this.perform({ kind: 'remove', id }, () => this.bridge!.remove({ connectionID: id, expectedRevision, ...(replacementDefault === undefined ? {} : { replacementDefault }) }));
  }
  async deleteModel(id: string, revision: number, entry: string, replacement?: string | null): Promise<boolean> {
    const saved = this.saved(id);
    if (!this.canWrite() || !saved || saved.revision !== revision || this.state.drafts.has(id)
      || !saved.models.some(model => model.entryID === entry)) return false;
    if (saved.models.length === 1) return this.remove(id, replacement);
    const models = saved.models.filter(model => model.entryID !== entry);
    if (saved.defaultModelEntryID === entry ? !models.some(model => model.entryID === replacement) : replacement !== undefined) return false;
    const { edit } = toDraft(saved);
    const connection = { ...edit, models, defaultModelEntryID: replacement ?? saved.defaultModelEntryID };
    return this.perform({ kind: 'remove-entry', id }, () => this.bridge!.save({ connection, expectedRevision: revision, credential: { kind: 'keep' } }));
  }
  discoveryBlockedReason(id: string): string | undefined {
    const saved = this.saved(id), draft = this.state.drafts.get(id);
    if (!this.bridge?.discover || !this.bridge.cancelDiscovery) return '此工作区未接入模型发现。';
    if (!saved) return '请先保存连接，再获取列表。';
    if (this.stale(id) || this.state.needsRefresh || this.state.requiresRestart) return '请先核对已保存的连接版本。';
    if (draft && (draft.detach || draft.proposedProtocol || draft.edit.baseURL !== saved.baseURL ||
        draft.edit.apiProtocol !== saved.apiProtocol)) return '请先保存地址、协议和凭证变更，再获取列表。';
    if (this.state.operation || this.state.discovery?.kind === 'pending' || this.state.connectionTest?.kind === 'pending') return '已有模型操作在处理。';
    return undefined;
  }
  private testInput(id: string, entryID?: string): ModelProbeInput | undefined {
    const saved = this.saved(id), connection = this.state.drafts.get(id)?.edit ?? saved;
    const entry = connection?.models.find(item => item.entryID === (entryID ?? connection.defaultModelEntryID));
    if (!saved || !connection || !entry) return;
    const input = { connectionID: id, expectedRevision: saved.revision, entryID: entry.entryID, modelID: entry.modelID,
      ...(entry.maxOutputTokens === undefined ? {} : { maxOutputTokens: entry.maxOutputTokens }),
      ...connection.compatibility, ...entry.compatibility };
    return validProbeInput(input) ? input : undefined;
  }
  connectionTestBlockedReason(id: string, entryID?: string): string | undefined {
    const saved = this.saved(id), draft = this.state.drafts.get(id);
    if (!this.bridge?.testConnection || !this.bridge.cancelConnectionTest) return '此工作区未接入连接测试。';
    if (this.state.probeStorageUnavailable) return '连接测试记录暂不可读取，请重新读取后再试。';
    if (!saved) return '请先保存连接，再测试。';
    if (this.stale(id) || this.state.needsRefresh || this.state.requiresRestart) return '请先核对已保存的连接版本。';
    if (draft && (draft.detach || draft.proposedProtocol || draft.edit.baseURL !== saved.baseURL ||
        draft.edit.apiProtocol !== saved.apiProtocol)) return '请先保存地址、协议或凭证变更，再测试。';
    if (!this.testInput(id, entryID)) return '请填写有效的模型 API ID 和输出设置。';
    if (this.state.operation || this.state.discovery?.kind === 'pending' || this.state.connectionTest?.kind === 'pending') return '已有模型操作在处理。';
  }
  savedDefaultTestBlockedReason(id: string, expectedRevision: number): string | undefined {
    const saved = this.saved(id);
    if (!saved || saved.revision !== expectedRevision) return '请先核对已保存的连接版本。';
    if (this.state.drafts.has(id)) return '请先保存或取消此连接的草稿。';
    return this.connectionTestBlockedReason(id);
  }
  async testSavedDefault(id: string, expectedRevision: number): Promise<ModelProbeReply | undefined> {
    if (this.savedDefaultTestBlockedReason(id, expectedRevision)) return;
    this.prepareConnectionTest(id);
    return this.confirmConnectionTest(id);
  }
  prepareConnectionTest(id: string, entryID?: string): void {
    if (this.connectionTestBlockedReason(id, entryID)) return;
    this.update({ connectionTest: { kind: 'confirm', explicitEntry: entryID !== undefined, input: { ...this.testInput(id, entryID)!, operationID: this.makeID() } } });
  }
  async confirmConnectionTest(id: string): Promise<ModelProbeReply | undefined> {
    const current = this.state.connectionTest;
    if (current?.kind !== 'confirm' || current.input.connectionID !== id || this.connectionTestBlockedReason(id, current.input.entryID)) return;
    const { operationID, ...input } = current.input;
    if (JSON.stringify(input) !== JSON.stringify(this.testInput(id, current.explicitEntry ? input.entryID : undefined))) { this.cancelConnectionTest(id); return; }
    const pending = { kind: 'pending', input: current.input } as const;
    this.update({ connectionTest: pending });
    let result: ModelProbeReply;
    try { const reply = await this.bridge!.testConnection!(pending.input); result = isProbeReply(reply, input) ? reply : probeError('unavailable'); }
    catch { result = probeError('unavailable'); }
    if (this.state.connectionTest !== pending || this.saved(id)?.revision !== input.expectedRevision) return;
    const completed = { kind: 'result', input: pending.input, result } as const;
    const recorded = result.ok || isRecordedProbeFailure(result.error);
    this.update({ connectionTest: completed, ...(recorded && !this.state.drafts.has(id) ? {
      probeResults: new Map(this.state.probeResults).set(probeResultKey(id, input.entryID), completed),
    } : {}) });
    return result;
  }
  cancelConnectionTest(id?: string, showCancellation = false): void {
    const current = this.state.connectionTest;
    if (!current || id !== undefined && id !== current.input.connectionID) return;
    const cancelled = showCancellation && current.kind === 'pending'
      ? { kind: 'result', input: current.input, result: probeError('cancelled') } as const : undefined;
    this.update({ connectionTest: cancelled });
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
  private async perform(operation: Operation, run: () => Promise<ModelWorkspaceReply>): Promise<boolean> {
    this.cancelDiscovery();
    this.cancelConnectionTest();
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
        feedback: { id, text: messages[result.error] + suffix, error: true } });
      return false;
    }
    const drafts = new Map(this.state.drafts);
    if (id && (kind === 'save' || kind === 'remove')) drafts.delete(id);
    const note = kind === 'remove-entry' ? '模型已从本地配置移除。' : kind === 'remove' ? '连接已从本地配置移除。' : kind === 'default' ? '已更新本地默认值。' : '已保存本地配置，尚未测试连接。';
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
    const revisions = new Map(result.configuration.connections.map(connection => [connection.id, connection.revision]));
    // A successful list replaces the evidence, including an empty or unreadable store.
    // Mutation responses do not carry probe records; retain only unchanged revisions there.
    const probeResults = new Map(kind === 'load' ? [] : [...(this.state.probeResults ?? [])].filter(([, item]) =>
      revisions.get(item.input.connectionID) === item.input.expectedRevision));
    for (const record of result.probeResults ?? []) {
      if (!validProbeRecord(record)) continue;
      const connection = result.configuration.connections.find(item => item.id === record.input.connectionID);
      const entry = connection?.models.find(item => item.entryID === record.input.entryID);
      // Draft probes are retained on disk, but cannot validate a different saved model/settings.
      if (!connection || !entry || connection.revision !== record.input.expectedRevision || entry.modelID !== record.input.modelID ||
          entry.maxOutputTokens !== record.input.maxOutputTokens ||
          (entry.compatibility.outputTokenField ?? connection.compatibility.outputTokenField) !== record.input.outputTokenField) continue;
      probeResults.set(probeResultKey(connection.id, entry.entryID), { kind: 'result',
        input: { ...record.input, operationID: 'persisted-probe' }, result: record.result });
    }
    this.update({ configuration: result.configuration, drafts, expanded, expandedModels, probeResults, needsRefresh: !!durability,
      ...(kind === 'load' ? { probeStorageUnavailable: result.probeStorageUnavailable } : {}),
      requiresRestart: this.state.requiresRestart || result.writesBlocked === true, operation: undefined,
      feedback: kind === 'load' ? undefined : { id: kind === 'remove' ? undefined : id, text: note + durability + retained } });
    return true;
  }
}
