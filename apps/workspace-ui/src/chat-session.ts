import { validVoiceDraft } from '../../../packages/contracts/src/voice-draft.ts';
import { chatHistoryTitle, isHistoryDetail, validChatProjectName, type ChatHistoryDetail } from '../../../packages/contracts/src/chat-history.ts';
import { emptyChatState } from './empty-chat.ts';
import { isRecordReadResult, isRecordWriteResult, isRecordSnapshot, matchesChatMemory, parseChatMemoryCommand, type Memory, type RecordSnapshot } from '../../../packages/contracts/src/character-records.ts';
import { canReloadMemory, type ChatMemoryBridge, type ChatMemoryProposal } from './chat-memory.ts';
import { acceptedChatText, validChatRequestID, isChatListResult, isChatSendResult, isMaterialApprovalResult, sameChatRoute, validOnlineChatInput, type ChatErrorCode, type ChatExchange, type ChatConversation, type ChatOption, type ChatRoute, type OnlineChatBridge } from '../../../packages/contracts/src/online-chat.ts';
import { attachmentModality, validateChatAttachments, type ChatAttachment } from '../../../packages/contracts/src/chat-attachments.ts';
import { defaultReasoningEffort, type ReasoningEffort } from '../../../packages/contracts/src/model-capabilities.ts';
import type { InputModality } from '../../../packages/contracts/src/models.ts';
import { isLocalChatResult, parseLocalChatCommand, type LocalChatBridge, type LocalChatInput } from '../../../packages/contracts/src/local-chat.ts';
import { acceptedDraft, sameDraft, textDraft, type ChatDraft } from './chat-draft.ts';

/** 按桌宠实例和会话隔离的窗口内状态。 */
export type ChatTurn = { id: string; role: 'user' | 'assistant'; text: string; createdAt: number; localOnly?: true; replayRoute?: string; replyTo?: string; memory?: ChatMemoryProposal };
export type ChatRequest = { characterId: string; model: string; text: string; history: ChatTurn[] };
export type LocalChatShortcut = '查看本机身份' | '查看目标进度' | '查角色知识：' | '查个人记忆：' | '记住：';
export type ChatCharacter = { id: string; name: string };
export type ChatModel = { id: string; name: string; modelName?: string; providerName?: string; reasoningLevels?: ReasoningEffort[]; reasoningEffort?: ReasoningEffort; ready?: boolean; isDefault?: boolean; inputModalities?: InputModality[]; taskRoute?: Omit<ChatRoute, 'useDefault'>; taskToolsUnverified?: boolean };
export type ChatAdapter = { models: ChatModel[]; reply(request: ChatRequest, signal: AbortSignal): Promise<string> };
export type ChatContextUsage = { inputTokens?: number; contextWindow?: number };
export type ChatSession = { draft: string; draftSnapshot: ChatDraft; turns: ChatTurn[]; attachments: Pick<ChatAttachment, 'name' | 'mediaType'>[]; awaitingApproval?: boolean; fullyAllowed?: boolean; materialPermissionKey?: string; projectID?: string; projectName?: string; pending: boolean; failed: boolean; status: string; model?: string; reasoningEffort?: ReasoningEffort; contextUsage?: ChatContextUsage; confirmingClear: boolean; editorKey?: string; title?: string; hasEarlier?: boolean; savedTurnID?: string; canReturnToCurrent?: boolean };
export type ChatWorkspaceState = { characters: ChatCharacter[]; selectedId?: string; models: ChatModel[]; available: boolean; localAvailable: boolean; memoryAvailable?: boolean; online?: boolean; materialApproval?: boolean; persistentConversations?: boolean; historyEpoch?: number; canRetry?: boolean; detachedDrafts: { id: string; label: string; enabled: boolean }[]; session: ChatSession };
type Attempt = { draft: ChatDraft; userTurn: ChatTurn; history: ChatTurn[]; local?: LocalChatInput; model?: string; route?: ChatRoute; reasoningEffort?: ReasoningEffort; exchanges?: ChatExchange[]; transmitted?: true; attachmentsUsed?: true };
type Session = Omit<ChatSession, 'draft' | 'editorKey' | 'attachments' | 'materialPermissionKey' | 'contextUsage'> & { usageByRoute?: Map<string, number>; attachments: ChatAttachment[]; editorKey: string; attempt?: Attempt; active?: { abort: AbortController; draftAtStart: ChatDraft }; conversation?: ChatConversation; lastSavedRequestID?: string; chooseModel?: true; reasoningChoice?: { route: string; effort: ReasoningEffort }; detachedFrom?: string; approvalRoute?: string; approvalRevision?: number; navigationDraft?: true };
type PetSessions = { base: Session; current: Session; historyEpoch?: number; cached: Map<string, Session> };
const maxCachedConversations = 12;
const maxUsageRoutes = 32;
const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
export const characterCount = (text: string): number => [...segmenter.segment(text)].length;
const prefix = (text: string, limit: number): string => [...segmenter.segment(text)].slice(0, limit).map(item => item.segment).join('');
export function validatedMessage(raw: string): string | undefined {
 const text = raw.trim();
 return text && characterCount(text) <= 1200 ? text : undefined;
}
export function trimTranscript(turns: ChatTurn[]): ChatTurn[] {
 const next = turns.slice(-12);
 let count = next.reduce((sum, turn) => sum + characterCount(turn.text), 0);
 while (count > 6000 && next.length > 2) count -= characterCount(next.shift()!.text);
 return next;
}
export function requestHistory(turns: ChatTurn[]): ChatTurn[] {
 return trimTranscript(turns.filter(turn => !turn.localOnly).map(turn => ({ ...turn, text: prefix(turn.text, 1200) })));
}
const routeID = (route: ChatRoute) => `${route.connectionID}/${route.modelEntryID}/${route.fingerprint}`;
function onlineHistory(turns: ChatTurn[], route: ChatRoute): ChatExchange[] {
 return turns.flatMap((turn, i) => {
  const prior = turns[i - 1];
  if (turn.localOnly || prior?.localOnly || turn.role !== 'assistant' || turn.replayRoute !== routeID(route) || prior?.role !== 'user' || prior.id !== turn.replyTo) return [];
  return [{ user: prior.text, assistant: prefix(turn.text, 1200) }];
 }).slice(-5);
}
class ChatFailure extends Error { constructor(readonly code: ChatErrorCode) { super(code); } }
const chatFailureMessage: Partial<Record<ChatErrorCode, string>> = {
 route_changed: '已保存的模型路由发生变化，请核对后重新选模。',
 context_changed: '角色资料或授权已变化，本轮未保留回复。请重试。',
 not_found: '当前角色已不存在。',
 conversation_missing: '这个会话已不存在。草稿已保留，可清空本轮后重新开始。',
 credentials_unavailable: '无法读取此连接的 Key，请检查模型管理或系统授权。',
 authentication_failed: '服务商未接受此连接的凭证，请检查模型管理。',
 rate_limited: '服务商限制了本次请求，请稍后重试。',
 busy: '模型服务正在处理其他请求，请稍后重试。',
 timed_out: '等待回复超时，服务商可能仍在处理已收到的请求。',
 approval_required: '本轮附件未获有效授权，请重新添加并批准。',
 tools_unavailable: '所选模型不支持文本附件工具。请切换模型或移除文本附件。',
 unavailable: '暂时无法使用本机模型服务，请稍后重试。',
};
const emptySession = (model?: string): Session => ({ draftSnapshot: textDraft(''), turns: [], attachments: [], pending: false, failed: false, status: '', model, confirmingClear: false, editorKey: crypto.randomUUID() });


export class ChatWorkspaceController {
 private sessions = new Map<string, PetSessions>();
 private characters: ChatCharacter[] = [];
 private selectedId?: string;
 private state: ChatWorkspaceState = emptyChatState;
 private listeners = new Set<() => void>();
 private readonly models: ChatModel[];
 private options: ChatOption[] = [];
 private refreshing?: Promise<void>;
 private durable = false;
 constructor(private readonly adapter?: ChatAdapter, private readonly local?: LocalChatBridge, private readonly online?: OnlineChatBridge, private readonly memory?: ChatMemoryBridge, private readonly hasHistoryBridge = false) { this.models = structuredClone(adapter?.models ?? []); }
 refreshModels() {
  if (!this.online) return Promise.resolve();
  if (this.refreshing) return this.refreshing;
  const read = async () => {
   try {
    const result = await this.online!.list();
    if (!isChatListResult(result) || !result.ok) throw Error();
    this.options = result.models;
    this.durable = this.hasHistoryBridge && result.persistentConversations === true;
   } catch { this.options = []; }
   finally { this.refreshing = undefined; this.publish(); }
  };
  return this.refreshing = Promise.resolve().then(read);
 }
 private selectedOption(own: Session) {
  if (own.chooseModel) return;
  const explicit = own.model ? this.options.find(option => option.ready && routeID(option.route) === own.model) : undefined;
  return explicit ?? this.options.find(option => option.ready && option.isDefault);
 }
 private route(own: Session): ChatRoute | undefined {
  const selected = this.selectedOption(own);
  if (!selected?.ready) return undefined;
  const explicit = !!own.model && routeID(selected.route) === own.model;
  return { ...selected.route, ...(!explicit && selected.isDefault ? { useDefault: true } : {}) };
 }
 private reasoning(own: Session): ReasoningEffort | undefined {
  const selected = this.selectedOption(own);
  const levels = selected?.reasoningLevels;
  if (!selected || !levels?.length) return;
  const choice = own.reasoningChoice;
  if (choice?.route === routeID(selected.route) && levels.includes(choice.effort)) return choice.effort;
  return selected.reasoningEffort ?? defaultReasoningEffort(levels);
 }
 selectReasoning(effort: ReasoningEffort) {
  const own = this.current();
  const selected = own && this.selectedOption(own);
  if (!own || own.pending || !selected?.reasoningLevels?.includes(effort)) return;
  this.resetApproval(own);
  own.reasoningChoice = { route: routeID(selected.route), effort };
  this.publish();
 }
 private retryable(own: Session) {
  const attempt = own.attempt;
  if (!attempt || attempt.attachmentsUsed) return false;
  if (attempt.local) return !!this.local;
  if (attempt.route) {
   const current = this.route(own);
   return !!current && sameChatRoute(current, attempt.route) && current.useDefault === attempt.route.useDefault;
  }
  return !!this.adapter && own.model === attempt.model;
 }
 getSnapshot = (): ChatWorkspaceState => this.state;
 subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
 private currentSet() { return this.selectedId ? this.sessions.get(this.selectedId) : undefined; }
 private current() { return this.currentSet()?.current; }
 newConversation(projectID?: string, projectName?: string): boolean {
  const entry = this.currentSet();
  if (!entry || !this.durable || entry.current.pending || (projectID !== undefined && !validChatRequestID(projectID)) || !this.park(entry)) return false;
  const next = emptySession(this.models[0]?.id);
  next.projectID = projectID;
  if (projectID && validChatProjectName(projectName)) next.projectName = projectName;
  next.navigationDraft = true;
  next.title = '新会话';
  entry.current = next;
  this.publish(); return true;
 }
 continueConversation(petID: string, detail: ChatHistoryDetail, projectName?: string): boolean {
  const entry = this.currentSet();
  if (!this.durable || !this.online || !entry || petID !== this.selectedId || entry.current.pending || !isHistoryDetail(detail, detail.session.id)) return false;
  const { id } = detail.session;
  let own = entry.current.conversation?.id === id ? entry.current : entry.base.conversation?.id === id ? entry.base : [...entry.cached.values()].find(session => session.conversation?.id === id);
  if (own !== entry.current && !this.park(entry)) return false;
  if (!own) {
   if (entry.cached.size >= maxCachedConversations) {
    const reusable = [...entry.cached].find(([, session]) => session !== entry.current && !session.draftSnapshot.text && !session.failed && !session.turns.some(turn => turn.localOnly));
    if (!reusable) return false;
    entry.cached.delete(reusable[0]);
   }
   own = emptySession();
   own.chooseModel = true;
   entry.cached.set(own.editorKey, own);
  }
  const latest = detail.turns.at(-1)?.requestID;
  // A preview can predate a reply that finished while the user was reading it.
  // Only reconcile an existing live transcript when the snapshot extends its last confirmed turn.
  const known = own.lastSavedRequestID;
  if (known !== latest && (!known || detail.turns.some(turn => turn.requestID === known))) {
   own.turns = detail.turns.flatMap(turn => [
    { id: `${turn.requestID}-user`, role: 'user', text: turn.user, createdAt: turn.completedAt },
    { id: `${turn.requestID}-assistant`, role: 'assistant', text: turn.assistant, createdAt: turn.completedAt },
   ]);
   own.lastSavedRequestID = latest;
   own.hasEarlier = detail.hasEarlier;
   own.attempt = undefined; own.failed = false; own.confirmingClear = false;
   own.status = own.chooseModel ? '请选择用于续聊的模型。' : '';
  }
  this.resetApproval(own);
  own.title = chatHistoryTitle(detail.session);
  if (own.projectID !== detail.session.projectID) own.projectName = undefined;
  own.projectID = detail.session.projectID;
  if (own.projectID && validChatProjectName(projectName)) own.projectName = projectName;
  own.conversation = { id, mode: 'resume', ...(own.projectID && { projectID: own.projectID }) };
  entry.current = own;
  this.publish();
  return true;
 }
 returnToCurrentChat(): boolean {
  const entry = this.currentSet();
  if (!entry || entry.current === entry.base || entry.current.pending) return false;
  if (!this.park(entry)) return false;
  entry.current = entry.base;
  this.publish();
  return true;
 }
 openDetachedDraft(id: string): boolean {
  const entry = this.currentSet();
  const own = entry?.cached.get(id);
  if (!entry || !own?.detachedFrom || own === entry.current || !own.draftSnapshot.text || entry.current.pending || !this.park(entry)) return false;
  entry.current = own;
  if (!own.failed) own.status = own.conversation ? '已恢复未发送的草稿。' : '已恢复未发送的草稿。发送后会开启新会话。';
  this.publish();
  return true;
 }
 private canPark({ current, base, cached }: PetSessions): boolean {
  return current === base || !current.draftSnapshot.text || cached.has(current.editorKey) ||
   (!!current.navigationDraft || !!current.detachedFrom || current.conversation?.mode === 'resume') &&
   (cached.size < maxCachedConversations || [...cached.values()].some(session => this.canEvict(session)));
 }
 private canEvict(session: Session) { return !session.draftSnapshot.text && !session.failed && !session.turns.some(turn => turn.localOnly); }
 private park(entry: PetSessions): boolean {
  if (!this.canPark(entry)) return false;
  const { current, base, cached } = entry;
  current.attachments = [];
  this.resetApproval(current);
  if (current !== base && !cached.has(current.editorKey) && (current.draftSnapshot.text || current.conversation?.mode === 'resume')) {
   if (cached.size >= maxCachedConversations) {
    const reusable = [...cached].find(([, session]) => this.canEvict(session));
    if (reusable) cached.delete(reusable[0]);
   }
   if (cached.size < maxCachedConversations) {
    if (current.draftSnapshot.text && current.conversation?.mode !== 'resume') current.detachedFrom ??= current.title ?? '新会话';
    cached.set(current.editorKey, current);
   }
  }
  return true;
 }
 historyCleared(petID: string): boolean {
  const entry = this.sessions.get(petID);
  if (!entry || entry.current.pending) return false;
  for (const [id, own] of entry.cached) {
   if (!own.draftSnapshot.text) entry.cached.delete(id);
   else {
    // The window still owns this draft; it must no longer refer to a saved conversation.
    own.detachedFrom ??= own.title ?? '原会话';
    if (own !== entry.current) {
     this.detach(own);
     own.turns = []; own.attempt = undefined; own.failed = false; own.status = '';
    }
   }
  }
  for (const own of new Set([entry.base, entry.current])) this.detach(own);
  entry.historyEpoch = (entry.historyEpoch ?? 0) + 1;
  if (petID === this.selectedId) this.publish();
  return true;
 }
 private detach(own: Session) {
  this.resetApproval(own);
  own.usageByRoute = undefined;
  own.conversation = undefined; own.title = undefined; own.lastSavedRequestID = undefined; own.hasEarlier = false;
  // A retry of an erased online turn must not try to recover the deleted history.
  if (own.attempt?.route) { own.attempt = undefined; own.failed = false; own.status = ''; }
 }
 private publish() {
  const entry = this.currentSet();
  const own = entry?.current;
  if (own?.approvalRoute && own.approvalRoute !== this.approvalScope(own)) this.resetApproval(own);
  const selection = own && this.selectedOption(own);
  const route = own && this.route(own);
  const reasoningEffort = own && this.reasoning(own);
  const contextUsage = own && route && selection && { inputTokens: own.usageByRoute?.get(routeID(route)), contextWindow: selection.contextWindow };
  // Stable across unrelated state publications, but not across approval-scope changes.
  const materialPermissionKey = own && JSON.stringify([own.editorKey, own.approvalRevision ?? 0, route && routeID(route), route?.useDefault, reasoningEffort]);
  const session: ChatSession = own ? { draft: own.draftSnapshot.text, draftSnapshot: own.draftSnapshot, turns: own.turns, attachments: own.attachments.map(({ name, mediaType }) => ({ name, mediaType })), awaitingApproval: own.awaitingApproval, fullyAllowed: own.fullyAllowed, materialPermissionKey, projectID: own.projectID, projectName: own.projectName, pending: own.pending, failed: own.failed, status: own.status, model: this.online ? selection && routeID(selection.route) : own.model, reasoningEffort, contextUsage, confirmingClear: own.confirmingClear, editorKey: own.editorKey, title: own.title, savedTurnID: own.lastSavedRequestID, hasEarlier: own.hasEarlier,
   canReturnToCurrent: !!entry && own !== entry.base && this.canPark(entry) } : emptyChatState.session;
  const canOpenDraft = !!entry && !entry.current.pending && this.canPark(entry);
  const detachedDrafts = entry ? [...entry.cached].flatMap(([id, parked]) =>
   parked !== own && parked.detachedFrom && parked.draftSnapshot.text ? [{ id, label: parked.detachedFrom, enabled: canOpenDraft }] : []) : [];
  const models = this.online ? this.options.map(option => ({ id: routeID(option.route), name: `${option.modelName} · ${option.connectionName}`, modelName: option.modelName, providerName: option.connectionName, reasoningLevels: option.reasoningLevels, reasoningEffort: option.reasoningEffort, ready: option.ready, isDefault: option.isDefault, inputModalities: option.inputModalities, ...(option.taskTools && { taskRoute: { ...option.route }, ...(option.taskTools === 'unverified' && { taskToolsUnverified: true }) }) })) : this.models;
  this.state = { characters: this.characters, selectedId: this.selectedId, models, available: this.online ? !!route : !!this.adapter && !!models.length,
   localAvailable: !!this.local, memoryAvailable: !!this.memory, online: !!this.online, materialApproval: !!this.online?.approveMaterials, persistentConversations: this.durable,
   historyEpoch: entry?.historyEpoch, canRetry: own ? this.retryable(own) : false, detachedDrafts, session };
  this.listeners.forEach(listener => listener());
 }
 syncCharacters(characters: ChatCharacter[]) {
  this.characters = characters.slice(0, 32).map(character => ({ ...character }));
  for (const [id] of this.sessions) if (!this.characters.some(character => character.id === id)) {
   if (id === this.selectedId) this.cancel();
   this.sessions.delete(id);
  }
  for (const character of this.characters) if (!this.sessions.has(character.id)) {
   const base = emptySession(this.models[0]?.id);
   this.sessions.set(character.id, { base, current: base, cached: new Map() });
  }
  if (!this.characters.some(character => character.id === this.selectedId)) this.selectedId = this.characters[0]?.id;
  this.publish();
 }
 selectCharacter(id: string) {
  if (id === this.selectedId || !this.characters.some(character => character.id === id)) return;
  this.cancel();
  const prior = this.current(); if (prior) prior.confirmingClear = false;
  this.selectedId = id; this.publish();
 }
 edit(text: string) { if (this.selectedId) this.editDraft(this.selectedId, textDraft(text)); }
 setAttachments(petID: string, attachments: ChatAttachment[], editorKey?: string): boolean {
  const own = this.current();
  if (!own || petID !== this.selectedId || own.pending || (editorKey !== undefined && editorKey !== own.editorKey)) return false;
  if (attachments.length && (!this.route(own) || !this.online?.approveMaterials)) return false;
  const validated = validateChatAttachments(attachments, own.draftSnapshot.text);
  if (!validated.ok) { own.status = '附件无效或超过大小、数量及文本限制。'; this.publish(); return false; }
  this.resetApproval(own);
  own.attachments = validated.attachments.map(({ name, mediaType, data }) => ({ name, mediaType, data }));
  own.status = '';
  this.publish();
  return true;
 }
 removeAttachment(petID: string, editorKey: string | undefined, name: string) {
  const own = this.current();
  if (!own || petID !== this.selectedId || editorKey !== own.editorKey || own.pending) return;
  this.resetApproval(own);
  own.attachments = own.attachments.filter(file => file.name !== name);
  own.status = ''; this.publish();
 }
 editDraft(petID: string, draft: ChatDraft, editorKey?: string): boolean {
  const own = this.current();
  if (!own || petID !== this.selectedId || (editorKey !== undefined && own.editorKey !== editorKey) || !acceptedDraft(draft)) return false;
  if (!sameDraft(own.draftSnapshot, draft)) {
   if (own.draftSnapshot.text !== draft.text) this.resetApproval(own);
   own.draftSnapshot = Object.freeze({ text: draft.text, selection: Object.freeze({ ...draft.selection }) });
   this.publish();
  }
  return true;
 }
 importVoiceDraft(petID: string, editorKey: string | undefined, initial: ChatDraft, text: string): boolean {
  const own = this.current();
  if (!own || petID !== this.selectedId || own.editorKey !== editorKey || own.pending || own.awaitingApproval || own.attachments.length ||
      own.draftSnapshot !== initial || initial.text || !validVoiceDraft(text)) return false;
  return this.editDraft(petID, textDraft(text), editorKey);
 }
 prefillLocalShortcut(shortcut: LocalChatShortcut): boolean {
  const own = this.current();
  if (!own || !(shortcut === '记住：' ? this.memory : this.local) || own.pending || own.draftSnapshot.text.trim()) return false;
  this.resetApproval(own);
  own.draftSnapshot = textDraft(shortcut);
  this.publish();
  return true;
 }
 selectModel(id: string) {
  const own = this.current();
  if (!own || own.pending) return;
  if (this.online) {
   if (id && !this.options.some(option => option.ready && routeID(option.route) === id)) return;
   this.resetApproval(own);
   own.model = id || undefined;
   if (own.chooseModel) { own.chooseModel = undefined; own.status = ''; }
   if (own.status && own.attempt?.route && !own.attempt.attachmentsUsed && !this.retryable(own)) own.status = this.durable && own.conversation
    ? '重新发送原问题时，会先找回已保存的回复；没有已保存回复才使用新模型。'
    : '已更改发送模型。再次发送会新建一轮请求。';
  } else {
   if (!this.models.some(model => model.id === id)) return;
   own.model = id;
  } this.publish();
 }
 private approvalScope(own: Session) {
  if (!this.online?.approveMaterials || !own.attachments.length || own.pending || !validatedMessage(own.draftSnapshot.text) ||
      parseLocalChatCommand(own.draftSnapshot.text) || parseChatMemoryCommand(own.draftSnapshot.text)) return;
  const route = this.route(own);
  if (route) return JSON.stringify([routeID(route), route.useDefault, this.reasoning(own)]);
 }
 private resetApproval(own: Session) {
  own.awaitingApproval = undefined; own.fullyAllowed = undefined; own.approvalRoute = undefined;
  own.approvalRevision = (own.approvalRevision ?? 0) + 1;
 }
 setMaterialPermission(allowed: boolean, editorKey?: string, expectedKey?: string) {
  const own = this.current();
  if (!own || own.pending || own.editorKey !== editorKey ||
      (expectedKey !== undefined && expectedKey !== this.state.session.materialPermissionKey)) return false;
  const scope = allowed ? this.approvalScope(own) : undefined;
  // The selector can be confirmed before composing; only an eligible, unchanged
  // turn gets an attachment approval scope. Adding or editing materials resets it.
  this.resetApproval(own);
  if (allowed) { own.fullyAllowed = true; own.approvalRoute = scope; }
  this.publish(); return true;
 }
 resolveMaterialApproval(allowed: boolean) {
  const own = this.current();
  if (!own?.awaitingApproval || !own.approvalRoute || own.approvalRoute !== this.approvalScope(own)) return Promise.resolve(false);
  this.resetApproval(own);
  if (!allowed) own.attachments = [];
  return this.submit(allowed);
 }
 send() { return this.submit(false); }
 private async submit(approved: boolean): Promise<boolean> {
  const own = this.current();
  const id = this.selectedId;
  if (!own || !id || own.pending) return false;
  const command = parseChatMemoryCommand(own.draftSnapshot.text);
  if (command) {
   if (own.attachments.length) { own.status = '本机记忆操作不接收附件。'; this.publish(); return false; }
   if (typeof command === 'string' || !this.memory || !validatedMessage(own.draftSnapshot.text)) return false;
   const turn: ChatTurn = { id: crypto.randomUUID(), role: 'user', text: own.draftSnapshot.text.trim(), createdAt: Date.now(), localOnly: true };
   own.turns = trimTranscript([...own.turns, turn]);
   this.resetApproval(own);
   own.draftSnapshot = textDraft('');
   own.attempt = undefined; own.failed = false; own.status = ''; own.confirmingClear = false;
   await this.readMemoryProposal(own, id, turn.id, command.text);
   return true;
  }
  const intent = parseLocalChatCommand(own.draftSnapshot.text);
  if (intent === 'invalid' || (intent && !this.local)) return false;
  if (own.attachments.length && intent) { own.status = '本机查询不接收附件。'; this.publish(); return false; }
  const local = intent && { petID: id, ...intent };
  const route = local ? undefined : this.route(own);
  if (!local && (!route && (!this.adapter || !own.model))) return false;
  const attachmentValidation = validateChatAttachments(own.attachments, own.draftSnapshot.text);
  if (!attachmentValidation.ok) { own.status = '附件无效或超过大小、数量及文本限制。'; this.publish(); return false; }
  const attachments = attachmentValidation.attachments.map(({ name, mediaType, data }) => ({ name, mediaType, data }));
  if (attachments.length && (!route || attachments.some(file => {
   const modality = attachmentModality(file);
   return modality && !this.selectedOption(own)?.inputModalities?.includes(modality);
  }))) {
   own.status = '当前模型未配置所需的图片或 PDF 输入能力。'; this.publish(); return false;
  }
  const text = validatedMessage(own.draftSnapshot.text);
  if (!text) { own.status = '单条消息最多1200字，请检查输入。'; this.publish(); return false; }
  if (route && !acceptedChatText(text)) { own.status = '消息超过在线字节限制或含不支持的字符。'; this.publish(); return false; }
  const scope = attachments.length ? this.approvalScope(own) : undefined;
  if (attachments.length && !approved && !(scope && own.fullyAllowed && own.approvalRoute === scope)) {
   if (scope) { own.awaitingApproval = true; own.approvalRoute = scope; }
   else own.status = '暂时无法批准本轮附件。';
   this.publish(); return false;
  }
  if (!attachments.length && own.failed && !own.attempt?.attachmentsUsed && own.attempt?.userTurn.text === text) {
   if (this.retryable(own)) {
    own.draftSnapshot = textDraft('');
    return this.perform(own, own.attempt, id);
   }
   if (route && this.durable && own.conversation && own.attempt.route) {
    // Explicit send can change the destination, but not the logical identity of the original question.
    const attempt = { ...own.attempt, route, reasoningEffort: this.reasoning(own), draft: own.draftSnapshot, exchanges: undefined };
    own.draftSnapshot = textDraft('');
    return this.perform(own, attempt, id, attachments);
   }
  }
  const attempt: Attempt = { draft: own.draftSnapshot, userTurn: { id: crypto.randomUUID(), role: 'user', text, createdAt: Date.now(), ...(local ? { localOnly: true } : {}) }, history: local || route ? [] : requestHistory(own.turns), local, model: own.model, route, reasoningEffort: route ? this.reasoning(own) : undefined, exchanges: route && !this.durable ? onlineHistory(own.turns, route) : undefined, ...(attachments.length ? { attachmentsUsed: true } : {}) };
  own.turns = trimTranscript([...own.turns, attempt.userTurn]);
  own.draftSnapshot = textDraft('');
  return this.perform(own, attempt, id, attachments);
 }
 private memoryAt(petID: string, messageID: string) {
  const own = this.selectedId === petID ? this.current() : undefined;
  const proposal = own?.turns.find(turn => turn.id === messageID)?.memory;
  return own && proposal && this.memory ? { own, proposal, bridge: this.memory } : undefined;
 }
 private setMemory(own: Session, petID: string, messageID: string, proposal: ChatMemoryProposal, previous?: ChatMemoryProposal) {
  const entry = this.sessions.get(petID);
  if (!entry || (entry.base !== own && entry.current !== own && ![...entry.cached.values()].includes(own)) || !own.turns.some(turn => turn.id === messageID && turn.memory === previous)) return false;
  own.turns = own.turns.map(turn => turn.id === messageID ? { ...turn, memory: proposal } : turn);
  this.publish();
  return true;
 }
 private memorySnapshot(petID: string) {
  return (value: unknown): value is RecordSnapshot<Memory> => isRecordSnapshot('memories', value, petID);
 }
 private async readMemoryProposal(own: Session, petID: string, messageID: string, text: string, previous?: ChatMemoryProposal) {
  const uncertain = previous?.state === 'uncertain';
  const reading: ChatMemoryProposal = { state: 'reading', text };
  if (!this.setMemory(own, petID, messageID, reading, previous)) return false;
  let next: ChatMemoryProposal = uncertain ? previous : { state: 'blocked', text, error: 'unavailable' };
  try {
   const result = await this.memory!.readMemories({ petID });
   if (isRecordReadResult(this.memorySnapshot(petID), result)) {
    if (result.ok) {
     if (!uncertain) next = { state: 'ready', text, revision: result.snapshot.revision };
     else if (result.snapshot.revision >= (previous.revisionFloor ?? 0)) {
      // A successful read is not a durability acknowledgement: never upgrade to saved.
      const found = result.snapshot.records.some(item => matchesChatMemory(item, messageID, text));
      next = { state: found ? 'observed' : 'not-observed', text };
     }
    } else if (!uncertain) next = { state: 'blocked', text, error: result.error };
   }
  } catch { /* Keep the proposal local; never recover by sending a model message or another write. */ }
  return this.setMemory(own, petID, messageID, next, reading);
 }
 async refreshMemoryProposal(petID: string, messageID: string) {
  const target = this.memoryAt(petID, messageID);
  if (!target) return false;
  const { own, proposal } = target;
  if (proposal.state !== 'uncertain' && !(proposal.state === 'blocked' && canReloadMemory(proposal.error))) return false;
  return this.readMemoryProposal(own, petID, messageID, proposal.text, proposal);
 }
 ignoreMemoryProposal(petID: string, messageID: string) {
  const target = this.memoryAt(petID, messageID);
  if (!target || (target.proposal.state !== 'ready' && target.proposal.state !== 'blocked')) return false;
  return this.setMemory(target.own, petID, messageID, { state: 'ignored', text: target.proposal.text }, target.proposal);
 }
 async saveMemoryProposal(petID: string, messageID: string) {
  const target = this.memoryAt(petID, messageID);
  if (!target || target.proposal.state !== 'ready') return false;
  const { own, bridge, proposal: { text, revision: expectedRevision } } = target;
  const saving: ChatMemoryProposal = { state: 'saving', text };
  if (!this.setMemory(own, petID, messageID, saving, target.proposal)) return false;
  let next: ChatMemoryProposal = { state: 'uncertain', text, revisionFloor: expectedRevision };
  try {
   const result = await bridge.saveChatMemory({ petID, messageID, text, expectedRevision });
   if (isRecordWriteResult(this.memorySnapshot(petID), result, expectedRevision)) {
    if (!result.ok && result.error !== 'write-outcome-unknown') next = { state: 'blocked', text, error: result.error };
    else if (result.ok && result.durability === 'confirmed' && result.snapshot.records.some(item => matchesChatMemory(item, messageID, text)))
     next = { state: 'saved', text };
   }
  } catch { /* A missing acknowledgement is not proof of failure. */ }
  return this.setMemory(own, petID, messageID, next, saving) && next.state === 'saved';
 }
 async retry(): Promise<boolean> {
  const own = this.current();
  if (!own || own.pending || own.attachments.length || !own.failed || !own.attempt || !this.retryable(own)) return false;
  if (own.draftSnapshot === own.attempt.draft) own.draftSnapshot = textDraft('');
  return this.perform(own, own.attempt, this.selectedId!);
 }
 private async perform(own: Session, attempt: Attempt, id: string, attachments: ChatAttachment[] = []): Promise<boolean> {
  const active = { abort: new AbortController(), draftAtStart: own.draftSnapshot };
  this.resetApproval(own);
  if (attachments.length) own.attachments = [];
  own.active = active; own.attempt = attempt; own.pending = true; own.failed = false; own.status = ''; own.confirmingClear = false;
  this.publish();
  try {
   let raw: string, replayable = false, historyNotice = '';
   let latestUsage: { route: ChatRoute; inputTokens?: number } | undefined;
   if (attempt.local) {
    const response = await this.local!.localChatContext(attempt.local);
    if (!isLocalChatResult(response, id) || !response.ok) throw new Error('local_context_unavailable');
    raw = response.text;
   } else if (attempt.route && this.online) {
    const turnID = this.durable ? attempt.userTurn.id : undefined;
    const requestID = turnID && !attempt.transmitted ? turnID : crypto.randomUUID();
    if (this.durable) own.conversation ??= { id: crypto.randomUUID(), mode: 'new', ...(own.projectID && { projectID: own.projectID }) };
    const conversation = own.conversation;
    const request = { requestID, petID: id, route: attempt.route, ...(attempt.reasoningEffort && { reasoningEffort: attempt.reasoningEffort }), text: attempt.userTurn.text, history: [...(attempt.exchanges ?? [])], ...(conversation && { conversation, turnID }), ...(attachments.length ? { attachments } : {}) };
    const validRequest = () => validOnlineChatInput(request);
    while (request.history.length && !validRequest()) request.history.shift();
    if (!validOnlineChatInput(request)) throw new ChatFailure('invalid_request');
    if (active.abort.signal.aborted) return false;
    const abort = () => { void this.online!.cancel(requestID).catch(() => {}); };
    active.abort.signal.addEventListener('abort', abort, { once: true });
    try {
     let materialGrant: string | undefined;
     if (attachments.length) {
      const grant = await this.online.approveMaterials?.(request);
      if (active.abort.signal.aborted || own.active !== active) return false;
      if (!isMaterialApprovalResult(grant) || !grant.ok) throw new ChatFailure('approval_required');
      materialGrant = grant.grant;
     }
     attempt.transmitted = true;
     const result = await this.online.send(materialGrant ? { ...request, materialGrant } : request);
     if (!isChatSendResult(result, requestID)) throw new ChatFailure('invalid_response');
     if (!result.ok) throw new ChatFailure(result.error);
     if (!result.recovered) latestUsage = { route: attempt.route, inputTokens: result.usage?.inputTokens };
     raw = result.text; replayable = result.replayable && !result.recovered && !attachments.length;
     if (own.active === active && conversation && !result.historyStatus) {
      own.conversation = { ...conversation, mode: 'resume' };
      own.lastSavedRequestID = turnID ?? requestID;
      own.detachedFrom = undefined;
     }
     historyNotice = result.recovered ? '已找回先前保存的回复；本次没有向模型发送请求。'
       : result.historyStatus === 'unconfirmed' ? '回复已收到，但未能确认已写入会话。'
       : result.historyStatus === 'omitted' ? '回复已收到；疑似含敏感内容，本轮未保存到历史。' : '';
    } finally { active.abort.signal.removeEventListener('abort', abort); }
   } else {
    const request = structuredClone({ characterId: id, model: attempt.model!, text: attempt.userTurn.text, history: attempt.history });
    raw = await this.adapter!.reply(request, active.abort.signal);
   }
   if (own.active !== active) return false;
   if (typeof raw !== 'string' || !raw.trim() || raw.length > 256_000) throw new Error('invalid_reply');
   own.turns = trimTranscript([...own.turns, { id: crypto.randomUUID(), role: 'assistant', text: raw.trim(), createdAt: Date.now(), ...(attempt.local ? { localOnly: true } : {}), ...(attempt.route && replayable ? { replayRoute: routeID(attempt.route), replyTo: attempt.userTurn.id } : {}) }]);
   if (latestUsage) {
    const key = routeID(latestUsage.route);
    own.usageByRoute?.delete(key);
    if (latestUsage.inputTokens !== undefined) {
     const usage = own.usageByRoute ??= new Map();
     usage.set(key, latestUsage.inputTokens);
     if (usage.size > maxUsageRoutes) usage.delete(usage.keys().next().value!);
    }
   }
   own.attempt = undefined;
   own.status = historyNotice;
   return true;
  } catch (error) {
   if (own.active !== active) return false;
   own.failed = true;
   this.restoreUnsubmitted(own, attempt, active.draftAtStart);
   own.status = attempt.local ? '暂时无法读取本机角色资料，可以重试。' : error instanceof ChatFailure ? chatFailureMessage[error.code] ?? '没有收到有效回复，可以重试。' : '没有收到有效回复，可以重试。';
   if (attempt.attachmentsUsed) own.status += ' 附件已清除；如需重新发送，请重新选择文件。';
   if (error instanceof ChatFailure && error.code === 'route_changed') void this.refreshModels();
   return false;
  } finally {
   if (own.active === active) {
    own.active = undefined; own.pending = false; this.publish();
   }
  }
 }
 cancel() {
  const own = this.current(); if (!own) return;
  this.resetApproval(own);
  if (own.attachments.length) own.attachments = [];
  if (!own.active) { this.publish(); return; }
  const active = own.active;
  own.active = undefined; own.pending = false; own.failed = true;
  if (own.attempt) this.restoreUnsubmitted(own, own.attempt, active.draftAtStart);
  own.status = own.attempt?.local ? '已停止等待本机查询。' : '已停止等待；已发出的请求可能仍由服务商处理。';
  active.abort.abort(); this.publish();
 }
 private restoreUnsubmitted(own: Session, attempt: Attempt, draftAtStart: ChatDraft) {
  // Once handed to the online bridge, keep the frozen prompt only on the failed turn.
  // An explicit recovery may restore it; neither failure nor cancellation edits a newer draft.
  if ((!attempt.route || !attempt.transmitted) && own.draftSnapshot === draftAtStart && !draftAtStart.text) own.draftSnapshot = attempt.draft;
 }
 restoreDraft() { const own = this.current(); if (own?.attempt && !own.draftSnapshot.text) { this.resetApproval(own); own.draftSnapshot = own.attempt.draft; this.publish(); } }
 requestClear() { const own = this.current(); if (own && !own.pending && own.turns.length) { own.confirmingClear = true; this.publish(); } }
 cancelClear() { const own = this.current(); if (own) { own.confirmingClear = false; this.publish(); } }
 confirmClear(): boolean {
  const own = this.current(); if (!own?.confirmingClear || own.pending) return false;
  const entry = this.currentSet();
  if (!own.detachedFrom || !own.draftSnapshot.text) entry?.cached.delete(own.editorKey);
  this.detach(own);
  own.turns = []; own.attempt = undefined; own.failed = false; own.confirmingClear = false; own.status = '本轮聊天已清空。'; this.publish(); return true;
 }
}
