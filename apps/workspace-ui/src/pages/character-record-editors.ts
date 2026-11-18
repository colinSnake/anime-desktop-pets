import { isMemoryHistorySnapshot, isRecordInput, isRecordSnapshot, type CharacterRecordsBridge, type Goal, type GoalDraft, type RecordInputs, type Memory, type MemoryDraft, type MemoryHistoryResult, type MemoryHistorySnapshot, type RecordSnapshot } from '../../../../packages/contracts/src/character-records.ts';
import { isKnowledgeFileResult, knowledgeBatchIssue, type KnowledgeFileBridge, type KnowledgeFileResult } from '../../../../packages/contracts/src/knowledge-import.ts';
import { isKnowledgeSearchInput, isKnowledgeSearchResult, usableKnowledge, type KnowledgeSearchBridge, type KnowledgeSearchError } from '../../../../packages/contracts/src/knowledge-search.ts';
import { RecordSession, type RecordState } from './record-session.ts';

export type MemoryMode = 'personal' | 'knowledge';
export type MemoryForm = Omit<MemoryDraft, 'kind' | 'expiresAt'> & { kind: Exclude<MemoryDraft['kind'], '知识'>; expiresAt: string };
export const emptyMemory: MemoryForm = { kind: '事实', text: '', source: '', citation: '', version: '', expiresAt: '' };
type MemoryEdit = { id: string; revision: number; mode: MemoryMode; expiresAt?: string; form: MemoryForm };
type KnowledgeImportDraft = { paragraphs: string[]; form: MemoryForm };
type MemoryForms = Record<MemoryMode, MemoryForm> & { editing?: MemoryEdit; knowledgeImport?: KnowledgeImportDraft };
type MemoryBridge = Pick<CharacterRecordsBridge, 'readMemories' | 'addMemory' | 'confirmMemory' | 'withdrawMemory' | 'readMemoryHistory' | 'editMemory' | 'restoreMemory' | 'addKnowledgeBatch' | 'deleteMemory' | 'setMemoryChatShare'> & KnowledgeFileBridge & KnowledgeSearchBridge;
export type KnowledgeLookup = { ok: true; matches: Memory[] } | { ok: false; error: KnowledgeSearchError };
export const memoryMode = (kind: Memory['kind']): MemoryMode => kind === '知识' ? 'knowledge' : 'personal';
export function memoryChangedOnDisk(edit: MemoryEdit, snapshot?: RecordSnapshot<Memory>) {
  return snapshot?.records.find(record => record.id === edit.id)?.revision !== edit.revision;
}
export function memoryEditInput({ draft: { editing }, snapshot }: RecordState<Memory, MemoryForms>) {
  if (!editing || !snapshot || memoryChangedOnDisk(editing, snapshot)) return;
  const draft = memoryValue(editing.form, editing.mode);
  if (!draft) return;
  if (editing.mode === 'personal') {
    draft.citation = editing.form.citation;
    draft.version = editing.form.version;
  } else if (editing.expiresAt && editing.expiresAt.slice(0, 10) === editing.form.expiresAt) {
    draft.expiresAt = editing.expiresAt;
  }
  const input = { petID: snapshot.petID, expectedRevision: snapshot.revision, id: editing.id, draft };
  if (isRecordInput('editMemory', input)) return input;
}
export function memoryValue(form: MemoryForm, mode: MemoryMode): MemoryDraft | undefined {
  const { text, source, citation, version, expiresAt } = form;
  if (mode === 'personal') return { kind: form.kind, text, source, citation: '', version: '' };
  const end = `${expiresAt}T23:59:59.999Z`;
  if (expiresAt && (!/^\d{4}-\d{2}-\d{2}$/.test(expiresAt) || !Number.isFinite(Date.parse(end)) || new Date(end).toISOString() !== end)) return;
  return { kind: '知识', text, source, citation, version, ...(expiresAt ? { expiresAt: end } : {}) };
}
type KnowledgePreparation = { issue: 'invalid' | 'source' | 'date' | NonNullable<ReturnType<typeof knowledgeBatchIssue>> } | { input: RecordInputs['addKnowledgeBatch'] };
export function prepareKnowledgeImport({ draft: { knowledgeImport }, snapshot }: RecordState<Memory, MemoryForms>): KnowledgePreparation {
  if (!knowledgeImport || !snapshot) return { issue: 'invalid' };
  const { paragraphs, form } = knowledgeImport;
  if (!form.source.trim()) return { issue: 'source' };
  const meta = memoryValue(form, 'knowledge');
  if (!meta) return { issue: 'date' };
  const citation = meta.citation.trim();
  const drafts = paragraphs.map((text, index) => ({ ...meta, kind: '知识' as const, text, source: meta.source.trim(),
    citation: citation ? `${citation}（导入文本第 ${index + 1} 段）` : '' }));
  const input = { petID: snapshot.petID, expectedRevision: snapshot.revision, drafts };
  if (!isRecordInput('addKnowledgeBatch', input)) return { issue: 'invalid' };
  const issue = knowledgeBatchIssue(drafts, snapshot.records, new Date().toISOString());
  return issue ? { issue } : { input };
}
export class MemorySession extends RecordSession<Memory, MemoryForms> {
  private choosingKnowledge = false;
  constructor(private bridge: MemoryBridge, petID: string) {
    super(petID, { personal: emptyMemory, knowledge: emptyMemory }, (value): value is RecordSnapshot<Memory> => isRecordSnapshot('memories', value, petID), bridge.readMemories);
  }
  async searchKnowledge(query: string): Promise<KnowledgeLookup | undefined> {
    const { snapshot, busy, needsRead } = this.getSnapshot();
    if (!snapshot || busy || needsRead) return;
    const input = { petID: this.petID, expectedRevision: snapshot.revision, query };
    if (!isKnowledgeSearchInput(input)) return { ok: false, error: 'invalid' };
    const generation = this.recordGeneration;
    const unavailable = { ok: false, error: 'unavailable' } as const;
    let response: unknown;
    try { response = await this.bridge.searchKnowledge(input); }
    catch { response = unavailable; }
    if (generation !== this.recordGeneration) return;
    if (!isKnowledgeSearchResult(response, input)) return unavailable;
    if (!response.ok) return response;
    const now = new Date().toISOString();
    const matches: Memory[] = [];
    for (const id of response.ids) {
      const record = snapshot.records.find(item => item.id === id);
      if (!record || !usableKnowledge(record, now)) return unavailable;
      matches.push(record);
    }
    return { ok: true, matches };
  }
  startEdit(id: string) {
    const { snapshot, draft, busy, needsRead } = this.getSnapshot();
    if (draft.editing || busy || needsRead) return;
    const record = snapshot?.records.find(item => item.id === id);
    if (!record) return;
    const { revision, kind, text, source, citation, version, expiresAt } = record;
    this.updateDraft({ ...draft, editing: { id, revision, mode: memoryMode(kind), expiresAt,
      form: { kind: kind === '知识' ? '事实' : kind, text, source, citation, version, expiresAt: expiresAt?.slice(0, 10) ?? '' } } });
  }
  updateEdit(update: (form: MemoryForm) => MemoryForm) {
    this.updateDraft(forms => forms.editing ? { ...forms, editing: { ...forms.editing, form: update(forms.editing.form) } } : forms);
  }
  cancelEdit() { this.updateDraft(forms => ({ ...forms, editing: undefined })); }
  async saveEdit() {
    const input = memoryEditInput(this.getSnapshot());
    if (input) await this.write(() => this.bridge.editMemory(input), forms => ({ ...forms, editing: undefined }));
  }
  async readHistory(id: string): Promise<MemoryHistoryResult | { ok: false; error: 'conflict' } | undefined> {
    const { snapshot, busy, needsRead } = this.getSnapshot();
    const record = snapshot?.records.find(item => item.id === id);
    if (!snapshot || !record || busy || needsRead) return;
    const scope = { petID: this.petID, id };
    const generation = this.recordGeneration;
    let result: MemoryHistoryResult = { ok: false, error: 'unavailable' };
    try {
      const value = await this.bridge.readMemoryHistory(scope);
      if (value?.ok === true && isMemoryHistorySnapshot(value.snapshot, scope)) result = value;
      if (value?.ok === false && (value.error === 'record-not-found' || value.error === 'not-found')) result = { ok: false, error: value.error };
    } catch { /* A failed read is distinct from a history with no versions. */ }
    const current = this.getSnapshot();
    if (generation !== this.recordGeneration || current.snapshot !== snapshot || current.busy || current.needsRead) return;
    if (result.ok && (result.snapshot.revision !== snapshot.revision || result.snapshot.currentRevision !== record.revision)) return { ok: false, error: 'conflict' };
    return result;
  }
  async restoreHistory(history: MemoryHistorySnapshot, historicalRevision: number) {
    const { snapshot, draft } = this.getSnapshot();
    const record = snapshot?.records.find(item => item.id === history.id);
    if (draft.editing || !record || !snapshot || history.revision !== snapshot.revision || history.currentRevision !== record.revision ||
        !isMemoryHistorySnapshot(history, { petID: this.petID, id: record.id }) || !history.history.some(item => item.revision === historicalRevision)) return;
    await this.write(expectedRevision => this.bridge.restoreMemory({ petID: this.petID, id: record.id, expectedRevision, historicalRevision }));
  }
  async chooseKnowledgeFile(isCurrent: () => boolean): Promise<KnowledgeFileResult | undefined> {
    const before = this.getSnapshot();
    if (!before.snapshot || before.busy || before.needsRead || before.draft.editing || before.draft.knowledgeImport || this.choosingKnowledge || !isCurrent()) return;
    this.choosingKnowledge = true;
    let result: KnowledgeFileResult = { ok: false, error: 'unavailable' };
    try {
      const value = await this.bridge.selectKnowledgeFile();
      if (isKnowledgeFileResult(value)) result = value;
    } catch { /* Never reveal native dialog or file-system errors. */ }
    finally { this.choosingKnowledge = false; }
    const current = this.getSnapshot();
    if (!isCurrent() || current.snapshot !== before.snapshot || current.busy || current.needsRead || current.draft.editing || current.draft.knowledgeImport) return;
    if (result.ok) this.updateDraft(forms => ({ ...forms, knowledgeImport: { paragraphs: result.paragraphs, form: emptyMemory } }));
    return result;
  }
  updateKnowledgeImport(update: (form: MemoryForm) => MemoryForm) {
    this.updateDraft(forms => forms.knowledgeImport ? { ...forms, knowledgeImport: { ...forms.knowledgeImport, form: update(forms.knowledgeImport.form) } } : forms);
  }
  cancelKnowledgeImport() { this.updateDraft(forms => ({ ...forms, knowledgeImport: undefined })); }
  async saveKnowledgeImport() {
    const state = this.getSnapshot();
    if (state.draft.editing || state.busy || state.needsRead) return;
    const prepared = prepareKnowledgeImport(state);
    if ('input' in prepared) await this.write(() => this.bridge.addKnowledgeBatch(prepared.input), forms => ({ ...forms, knowledgeImport: undefined }));
  }
  async add(mode: MemoryMode) {
    const draft = memoryValue(this.getSnapshot().draft[mode], mode);
    const input = { petID: this.petID, expectedRevision: this.getSnapshot().snapshot?.revision, draft };
    if (!isRecordInput('addMemory', input)) return;
    await this.write(() => this.bridge.addMemory(input), forms => ({ ...forms, [mode]: emptyMemory }));
  }
  requestDelete(id: string) {
    if (this.getSnapshot().draft.editing?.id !== id) this.stageDelete(id);
  }
  async confirmDelete(id: string) {
    const { draft, deleteID } = this.getSnapshot();
    if (id === deleteID && draft.editing?.id !== id) await this.deleteSelected(input => this.bridge.deleteMemory(input));
  }
  async setChatShare(id: string, enabled: boolean) {
    const state = this.getSnapshot();
    const record = state.snapshot?.records.find(item => item.id === id);
    if (record?.status !== 'confirmed' || (enabled && (state.draft.editing?.id === id || (!!record.expiresAt && Date.parse(record.expiresAt) <= Date.now())))) return;
    await this.updateChatShare(id, enabled, input => this.bridge.setMemoryChatShare(input));
  }
  async review(id: string, action: 'confirmMemory' | 'withdrawMemory') {
    const snapshot = this.getSnapshot().snapshot;
    const record = snapshot?.records.find(item => item.id === id);
    if (!record || (action === 'confirmMemory' ? record.status !== 'candidate' : record.status !== 'confirmed')) return;
    await this.write(expectedRevision => this.bridge[action]({ petID: this.petID, expectedRevision, id }));
  }
}
export const createMemorySession = (bridge: MemoryBridge, id: string) => new MemorySession(bridge, id);

export type GoalStepForm = { key: number; id?: string; text: string; done: boolean };
export type GoalForm = { title: string; detail: string; status: GoalDraft['status']; steps: GoalStepForm[]; nextStep: number; changed: boolean; editing?: { id: string; revision: number } };
export const emptyGoal: GoalForm = { title: '', detail: '', status: '进行中', steps: [], nextStep: 1, changed: false };
export function goalFormOf(goal: Goal): GoalForm {
  return { title: goal.title, detail: goal.details, status: goal.status, editing: { id: goal.id, revision: goal.revision }, changed: false,
    steps: goal.steps.map((step, i) => ({ key: i + 1, id: step.id, text: step.text, done: step.isComplete })), nextStep: goal.steps.length + 1 };
}
export function goalValue(form: GoalForm): GoalDraft {
  return { title: form.title, details: form.detail, status: form.status,
    steps: form.steps.map(({ id, text, done }) => ({ ...(id ? { id } : {}), text, isComplete: done })) };
}
export function goalChangedOnDisk(form: GoalForm, snapshot?: RecordSnapshot<Goal>) {
  return !!form.editing && snapshot?.records.find(goal => goal.id === form.editing?.id)?.revision !== form.editing.revision;
}
type GoalBridge = Pick<CharacterRecordsBridge, 'readGoals' | 'addGoal' | 'editGoal' | 'deleteGoal' | 'setGoalChatShare'>;
export class GoalSession extends RecordSession<Goal, GoalForm> {
  constructor(private bridge: GoalBridge, petID: string) {
    super(petID, emptyGoal, (value): value is RecordSnapshot<Goal> => isRecordSnapshot('goals', value, petID), bridge.readGoals);
  }
  requestDelete(id: string) {
    if (this.getSnapshot().draft.editing?.id !== id) this.stageDelete(id);
  }
  async confirmDelete(id: string) {
    const { draft, deleteID } = this.getSnapshot();
    if (id === deleteID && draft.editing?.id !== id) await this.deleteSelected(input => this.bridge.deleteGoal(input));
  }
  async setChatShare(id: string, enabled: boolean) {
    if (enabled && this.getSnapshot().draft.editing?.id === id) return;
    await this.updateChatShare(id, enabled, input => this.bridge.setGoalChatShare(input));
  }
  async save() {
    const { draft: form, snapshot } = this.getSnapshot();
    if (!form.changed || !snapshot || goalChangedOnDisk(form, snapshot)) return;
    const input = { petID: this.petID, expectedRevision: snapshot.revision, draft: goalValue(form) };
    const finish = () => emptyGoal;
    if (form.editing) {
      const update = { ...input, id: form.editing.id };
      if (isRecordInput('editGoal', update)) await this.write(() => this.bridge.editGoal(update), finish);
    } else if (isRecordInput('addGoal', input)) await this.write(() => this.bridge.addGoal(input), finish);
  }
}
export const createGoalSession = (bridge: GoalBridge, id: string) => new GoalSession(bridge, id);
