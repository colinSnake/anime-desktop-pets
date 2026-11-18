/** 纯内存会话；无网络、资料扫描或磁盘持久化。生产默认没有回复适配器。 */
export type ChatTurn = { id: string; role: 'user' | 'assistant'; text: string; createdAt: number };
export type ChatRequest = { characterId: string; model: string; text: string; history: ChatTurn[] };
export type ChatCharacter = { id: string; name: string };
export type ChatModel = { id: string; name: string };
export type ChatAdapter = { models: ChatModel[]; reply(request: ChatRequest, signal: AbortSignal): Promise<string> };
export type ChatSession = { draft: string; turns: ChatTurn[]; pending: boolean; failed: boolean; status: string; model?: string; confirmingClear: boolean };
export type ChatWorkspaceState = { characters: ChatCharacter[]; selectedId?: string; models: ChatModel[]; available: boolean; session: ChatSession };
type Attempt = { userTurn: ChatTurn; history: ChatTurn[] };
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
 return trimTranscript(turns.map(turn => ({ ...turn, text: prefix(turn.text, 1200) })));
}
const emptySession = (model?: string): Session => ({ draft: '', turns: [], pending: false, failed: false, status: '', model, confirmingClear: false });
export const emptyChatState: ChatWorkspaceState = { characters: [], models: [], available: false, session: emptySession() };

export class ChatWorkspaceController {
 private sessions = new Map<string, Session>();
 private characters: ChatCharacter[] = [];
 private selectedId?: string;
 private state: ChatWorkspaceState = emptyChatState;
 private listeners = new Set<() => void>();
 private readonly models: ChatModel[];
 constructor(private readonly adapter?: ChatAdapter) { this.models = structuredClone(adapter?.models ?? []); }
 getSnapshot = (): ChatWorkspaceState => this.state;
 subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
 private current() { return this.selectedId ? this.sessions.get(this.selectedId) : undefined; }
 private publish() {
  const own = this.current();
  const session: ChatSession = own ? { draft: own.draft, turns: own.turns, pending: own.pending, failed: own.failed, status: own.status, model: own.model, confirmingClear: own.confirmingClear } : emptySession();
  this.state = { characters: this.characters, selectedId: this.selectedId, models: this.models, available: !!this.adapter && this.models.length > 0, session };
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
  if (!own || own.pending || !this.models.some(model => model.id === id)) return;
  own.model = id; this.publish();
 }
 async send(): Promise<boolean> {
  const own = this.current();
  if (!own || own.pending || !this.adapter || !own.model) return false;
  const text = validatedMessage(own.draft);
  if (!text) { own.status = '单条消息最多1200字，请检查输入。'; this.publish(); return false; }
  if (own.failed && own.attempt?.userTurn.text === text) return this.retry();
  const attempt: Attempt = { userTurn: { id: crypto.randomUUID(), role: 'user', text, createdAt: Date.now() }, history: requestHistory(own.turns) };
  own.turns = trimTranscript([...own.turns, attempt.userTurn]);
  own.draft = '';
  return this.perform(own, attempt, this.selectedId!);
 }
 async retry(): Promise<boolean> {
  const own = this.current();
  if (!own || own.pending || !own.failed || !own.attempt || !this.adapter || !own.model) return false;
  if (own.draft.trim() === own.attempt.userTurn.text) own.draft = '';
  return this.perform(own, own.attempt, this.selectedId!);
 }
 private async perform(own: Session, attempt: Attempt, id: string): Promise<boolean> {
  const active = { token: Symbol(), abort: new AbortController() };
  own.active = active; own.attempt = attempt; own.pending = true; own.failed = false; own.status = ''; own.confirmingClear = false;
  const request = structuredClone({ characterId: id, model: own.model!, text: attempt.userTurn.text, history: attempt.history });
  this.publish();
  try {
   const raw = await this.adapter!.reply(request, active.abort.signal);
   if (own.active !== active) return false;
   if (typeof raw !== 'string' || !raw.trim() || raw.length > 256_000) throw new Error('invalid_reply');
   own.turns = trimTranscript([...own.turns, { id: crypto.randomUUID(), role: 'assistant', text: raw.trim(), createdAt: Date.now() }]);
   own.attempt = undefined;
   return true;
  } catch {
   if (own.active !== active) return false;
   own.failed = true;
   if (!own.draft) own.draft = attempt.userTurn.text;
   own.status = '没有收到有效回复，可以重试。';
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
  own.status = '已停止等待；已发出的请求可能仍由服务商处理。';
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
