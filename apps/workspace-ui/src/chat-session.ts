import { acceptedChatText, isChatListResult, isChatSendResult, sameChatRoute, validOnlineChatInput, type ChatErrorCode, type ChatExchange, type ChatOption, type ChatRoute, type OnlineChatBridge } from '../../../packages/contracts/src/online-chat.ts';
import { isLocalChatResult, parseLocalChatCommand, type LocalChatBridge, type LocalChatInput } from '../../../packages/contracts/src/local-chat.ts';

/** 按角色隔离的内存会话。 */
export type ChatTurn = { id: string; role: 'user' | 'assistant'; text: string; createdAt: number; localOnly?: true; replayRoute?: string; replyTo?: string };
export type ChatRequest = { characterId: string; model: string; text: string; history: ChatTurn[] };
export type ChatCharacter = { id: string; name: string };
export type ChatModel = { id: string; name: string; ready?: boolean; isDefault?: boolean };
export type ChatAdapter = { models: ChatModel[]; reply(request: ChatRequest, signal: AbortSignal): Promise<string> };
export type ChatSession = { draft: string; turns: ChatTurn[]; pending: boolean; failed: boolean; status: string; model?: string; confirmingClear: boolean };
export type ChatWorkspaceState = { characters: ChatCharacter[]; selectedId?: string; models: ChatModel[]; available: boolean; localAvailable: boolean; online?: boolean; modelStatus?: string; canRetry?: boolean; session: ChatSession };
type Attempt = { userTurn: ChatTurn; history: ChatTurn[]; local?: LocalChatInput; model?: string; route?: ChatRoute; exchanges?: ChatExchange[] };
type Session = ChatSession & { attempt?: Attempt; active?: { token: symbol; abort: AbortController } };
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
  if (turn.role !== 'assistant' || turn.replayRoute !== routeID(route) || prior?.role !== 'user' || prior.id !== turn.replyTo) return [];
  return [{ user: prior.text, assistant: prefix(turn.text, 1200) }];
 }).slice(-5);
}
class ChatFailure extends Error { constructor(readonly code: ChatErrorCode) { super(code); } }
const chatFailureMessage: Partial<Record<ChatErrorCode, string>> = {
 route_changed: '已保存的模型路由发生变化，请核对后重新选模。',
 context_changed: '角色资料或授权已变化，本轮未保留回复。请重试。',
 not_found: '当前角色已不存在。',
 credentials_unavailable: '无法读取此连接的 Key，请检查模型管理或系统授权。',
 authentication_failed: '服务商未接受此连接的凭证，请检查模型管理。',
 rate_limited: '服务商限制了本次请求，请稍后重试。',
 busy: '模型服务正在处理其他请求，请稍后重试。',
 timed_out: '等待回复超时，服务商可能仍在处理已收到的请求。',
 unavailable: '暂时无法使用本机模型服务，请稍后重试。',
};
const emptySession = (model?: string): Session => ({ draft: '', turns: [], pending: false, failed: false, status: '', model, confirmingClear: false });
export const emptyChatState: ChatWorkspaceState = { characters: [], models: [], available: false, localAvailable: false, session: emptySession() };

export class ChatWorkspaceController {
 private sessions = new Map<string, Session>();
 private characters: ChatCharacter[] = [];
 private selectedId?: string;
 private state: ChatWorkspaceState = emptyChatState;
 private listeners = new Set<() => void>();
 private readonly models: ChatModel[];
 private options: ChatOption[] = [];
 private modelStatus = '';
 private refreshing?: Promise<void>;
 constructor(private readonly adapter?: ChatAdapter, private readonly local?: LocalChatBridge, private readonly online?: OnlineChatBridge) { this.models = structuredClone(adapter?.models ?? []); }
 refreshModels() {
  if (!this.online) return Promise.resolve();
  if (this.refreshing) return this.refreshing;
  const read = async () => {
   this.modelStatus = '正在读取已保存模型…'; this.publish();
   try {
    const result = await this.online!.list();
    if (!isChatListResult(result) || !result.ok) throw Error();
    this.options = result.models;
    this.modelStatus = this.options.length ? '' : '请先在模型管理中保存模型。';
   } catch { this.options = []; this.modelStatus = '暂时无法读取已保存模型，请刷新。'; }
   finally { this.refreshing = undefined; this.publish(); }
  };
  return this.refreshing = Promise.resolve().then(read);
 }
 private selectedOption(own: Session) {
  return this.options.find(option => own.model ? routeID(option.route) === own.model : option.isDefault);
 }
 private route(own: Session): ChatRoute | undefined {
  const selected = this.selectedOption(own);
  return selected?.ready ? { ...selected.route, ...(!own.model ? { useDefault: true } : {}) } : undefined;
 }
 private retryable(own: Session) {
  const attempt = own.attempt;
  if (!attempt) return false;
  if (attempt.local) return !!this.local;
  if (attempt.route) {
   const current = this.route(own);
   return !!current && sameChatRoute(current, attempt.route) && current.useDefault === attempt.route.useDefault;
  }
  return !!this.adapter && own.model === attempt.model;
 }
 getSnapshot = (): ChatWorkspaceState => this.state;
 subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
 private current() { return this.selectedId ? this.sessions.get(this.selectedId) : undefined; }
 private publish() {
  const own = this.current();
  const selection = own && this.selectedOption(own);
  const session: ChatSession = own ? { draft: own.draft, turns: own.turns, pending: own.pending, failed: own.failed, status: own.status, model: this.online ? selection && routeID(selection.route) : own.model, confirmingClear: own.confirmingClear } : emptySession();
  const models = this.online ? this.options.map(option => ({ id: routeID(option.route), name: `${option.modelName} · ${option.connectionName}`, ready: option.ready, isDefault: option.isDefault })) : this.models;
  this.state = { characters: this.characters, selectedId: this.selectedId, models, available: this.online ? !!(own && this.route(own)) : !!this.adapter && !!models.length,
   localAvailable: !!this.local, online: !!this.online, modelStatus: own?.model && !selection && this.online && this.options.length ? '所选路由已变更，请重新选模。' : this.modelStatus,
   canRetry: own ? this.retryable(own) : false, session };
  this.listeners.forEach(listener => listener());
 }
 syncCharacters(characters: ChatCharacter[]) {
  this.characters = characters.slice(0, 32).map(character => ({ ...character }));
  for (const [id] of this.sessions) if (!this.characters.some(character => character.id === id)) {
   if (id === this.selectedId) this.cancel();
   this.sessions.delete(id);
  }
  for (const character of this.characters) if (!this.sessions.has(character.id)) this.sessions.set(character.id, emptySession(this.models[0]?.id));
  if (!this.characters.some(character => character.id === this.selectedId)) this.selectedId = this.characters[0]?.id;
  this.publish();
 }
 selectCharacter(id: string) {
  if (id === this.selectedId || !this.characters.some(character => character.id === id)) return;
  this.cancel();
  const prior = this.current(); if (prior) prior.confirmingClear = false;
  this.selectedId = id; this.publish();
 }
 edit(text: string) { const own = this.current(); if (own) { own.draft = text; this.publish(); } }
 selectModel(id: string) {
  const own = this.current();
  if (!own || own.pending) return;
  if (this.online) {
   if (id && !this.options.some(option => option.ready && routeID(option.route) === id)) return;
   own.model = id || undefined;
   if (own.status && own.attempt?.route && !this.retryable(own)) own.status = '已更改发送模型。再次发送会新建一轮请求。';
  } else {
   if (!this.models.some(model => model.id === id)) return;
   own.model = id;
  } this.publish();
 }
 async send(): Promise<boolean> {
  const own = this.current();
  const id = this.selectedId;
  if (!own || !id || own.pending) return false;
  const intent = parseLocalChatCommand(own.draft);
  if (intent === 'invalid' || (intent && !this.local)) return false;
  const local = intent && { petID: id, ...intent };
  const route = local ? undefined : this.route(own);
  if (!local && (!route && (!this.adapter || !own.model))) return false;
  const text = validatedMessage(own.draft);
  if (!text) { own.status = '单条消息最多1200字，请检查输入。'; this.publish(); return false; }
  if (route && !acceptedChatText(text)) { own.status = '消息超过在线字节限制或含不支持的字符。'; this.publish(); return false; }
  if (own.failed && own.attempt?.userTurn.text === text && this.retryable(own)) return this.retry();
  const attempt: Attempt = { userTurn: { id: crypto.randomUUID(), role: 'user', text, createdAt: Date.now(), ...(local ? { localOnly: true } : {}) }, history: local || route ? [] : requestHistory(own.turns), local, model: own.model, route, exchanges: route ? onlineHistory(own.turns, route) : undefined };
  own.turns = trimTranscript([...own.turns, attempt.userTurn]);
  own.draft = '';
  return this.perform(own, attempt, id);
 }
 async retry(): Promise<boolean> {
  const own = this.current();
  if (!own || own.pending || !own.failed || !own.attempt || !this.retryable(own)) return false;
  if (own.draft.trim() === own.attempt.userTurn.text) own.draft = '';
  return this.perform(own, own.attempt, this.selectedId!);
 }
 private async perform(own: Session, attempt: Attempt, id: string): Promise<boolean> {
  const active = { token: Symbol(), abort: new AbortController() };
  own.active = active; own.attempt = attempt; own.pending = true; own.failed = false; own.status = ''; own.confirmingClear = false;
  this.publish();
  try {
   let raw: string, replayable = false;
   if (attempt.local) {
    const response = await this.local!.localChatContext(attempt.local);
    if (!isLocalChatResult(response, id) || !response.ok) throw new Error('local_context_unavailable');
    raw = response.text;
   } else if (attempt.route && this.online) {
    const requestID = crypto.randomUUID();
    const request = { requestID, petID: id, route: attempt.route, text: attempt.userTurn.text, history: [...(attempt.exchanges ?? [])] };
    const validRequest = () => validOnlineChatInput(request);
    while (request.history.length && !validRequest()) request.history.shift();
    if (!validOnlineChatInput(request)) throw new ChatFailure('invalid_request');
    if (active.abort.signal.aborted) return false;
    const abort = () => { void this.online!.cancel(requestID).catch(() => {}); };
    active.abort.signal.addEventListener('abort', abort, { once: true });
    try {
     const result = await this.online.send(request);
     if (!isChatSendResult(result, requestID)) throw new ChatFailure('invalid_response');
     if (!result.ok) throw new ChatFailure(result.error);
     raw = result.text; replayable = result.replayable;
    } finally { active.abort.signal.removeEventListener('abort', abort); }
   } else {
    const request = structuredClone({ characterId: id, model: attempt.model!, text: attempt.userTurn.text, history: attempt.history });
    raw = await this.adapter!.reply(request, active.abort.signal);
   }
   if (own.active !== active) return false;
   if (typeof raw !== 'string' || !raw.trim() || raw.length > 256_000) throw new Error('invalid_reply');
   own.turns = trimTranscript([...own.turns, { id: crypto.randomUUID(), role: 'assistant', text: raw.trim(), createdAt: Date.now(), ...(attempt.local ? { localOnly: true } : {}), ...(attempt.route && replayable ? { replayRoute: routeID(attempt.route), replyTo: attempt.userTurn.id } : {}) }]);
   own.attempt = undefined;
   return true;
  } catch (error) {
   if (own.active !== active) return false;
   own.failed = true;
   if (!own.draft) own.draft = attempt.userTurn.text;
   own.status = attempt.local ? '暂时无法读取本机角色资料，可以重试。' : error instanceof ChatFailure ? chatFailureMessage[error.code] ?? '没有收到有效回复，可以重试。' : '没有收到有效回复，可以重试。';
   if (error instanceof ChatFailure && error.code === 'route_changed') void this.refreshModels();
   return false;
  } finally {
   if (own.active === active) { own.active = undefined; own.pending = false; this.publish(); }
  }
 }
 cancel() {
  const own = this.current(); if (!own?.active) return;
  const active = own.active;
  own.active = undefined; own.pending = false; own.failed = true;
  if (!own.draft) own.draft = own.attempt?.userTurn.text ?? '';
  own.status = own.attempt?.local ? '已停止等待本机查询。' : '已停止等待；已发出的请求可能仍由服务商处理。';
  active.abort.abort(); this.publish();
 }
 restoreDraft() { const own = this.current(); if (own?.attempt && !own.draft) { own.draft = own.attempt.userTurn.text; this.publish(); } }
 requestClear() { const own = this.current(); if (own && !own.pending && own.turns.length) { own.confirmingClear = true; this.publish(); } }
 cancelClear() { const own = this.current(); if (own) { own.confirmingClear = false; this.publish(); } }
 confirmClear(): boolean {
  const own = this.current(); if (!own?.confirmingClear || own.pending) return false;
  own.turns = []; own.attempt = undefined; own.failed = false; own.confirmingClear = false; own.status = '本轮聊天已清空。'; this.publish(); return true;
 }
}
