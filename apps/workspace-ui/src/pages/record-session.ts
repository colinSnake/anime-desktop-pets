import {
  isRecordReadResult, isRecordWriteResult,
  type CharacterRecord, type RecordError, type RecordReadResult, type RecordDeleteInput, type RecordChatShareInput, type RecordSnapshot, type RecordWriteResult,
} from '../../../../packages/contracts/src/character-records.ts';

type Update<D> = D | ((previous: D) => D);
export type RecordState<T extends CharacterRecord, D> = {
  draft: D;
  snapshot?: RecordSnapshot<T>;
  busy?: 'read' | 'write';
  needsRead?: boolean;
  error?: RecordError;
  deleteID?: string;
  notice?: 'deleted' | 'saved' | 'unchanged' | 'reloaded' | 'shared' | 'unshared';
};

export class RecordSession<T extends CharacterRecord, D extends object> {
  private state: RecordState<T, D>;
  private retired = false;
  private generation = 0;
  get recordGeneration() { return this.generation; }
  private listeners = new Set<() => void>();
  constructor(readonly petID: string, private initialDraft: D,
    private validSnapshot: (value: unknown) => value is RecordSnapshot<T>, private read: (input: { petID: string }) => Promise<RecordReadResult<T>>) {
    this.state = { draft: initialDraft };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: RecordState<T, D>) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  retire() { this.retired = true; this.generation++; this.publish({ draft: this.initialDraft }); }
  updateDraft = (update: Update<D>) => {
    if (this.retired || this.state.busy) return;
    const draft = typeof update === 'function' ? update(this.state.draft) : update;
    this.publish({ ...this.state, draft, notice: undefined });
  };
  protected stageDelete(id: string) {
    const state = this.state;
    if (!this.retired && !state.busy && !state.needsRead && state.snapshot?.records.some(record => record.id === id)) {
      this.publish({ ...state, deleteID: id, notice: undefined });
    }
  }
  cancelDelete() {
    if (this.state.deleteID) this.publish({ ...this.state, deleteID: undefined });
  }
  protected async deleteSelected(send: (input: RecordDeleteInput) => Promise<RecordWriteResult<T>>) {
    const { deleteID: id, snapshot } = this.state;
    if (!id || !snapshot || !snapshot.records.some(record => record.id === id)) return;
    const remaining = new Set(snapshot.records.filter(record => record.id !== id).map(record => record.id));
    await this.write(async expectedRevision => {
      const result = await send({ id, petID: this.petID, expectedRevision });
      if (result.ok && (result.durability === 'unchanged' || result.snapshot.records.length !== remaining.size ||
          result.snapshot.records.some(record => !remaining.has(record.id)))) return { ok: false, error: 'write-outcome-unknown' };
      return result;
    }, undefined, 'deleted');
  }
  protected async updateChatShare(id: string, enabled: boolean, send: (input: RecordChatShareInput) => Promise<RecordWriteResult<T>>) {
    const record = this.state.snapshot?.records.find(record => record.id === id);
    if (!record || (record.chatShare === true) === enabled) return;
    await this.write(async expectedRevision => {
      const result = await send({ id, petID: this.petID, expectedRevision, enabled });
      if (result.ok && !result.snapshot.records.some(item => item.id === id && item.revision === record.revision && (item.chatShare === true) === enabled))
        return { ok: false, error: 'write-outcome-unknown' };
      return result;
    }, undefined, enabled ? 'shared' : 'unshared');
  }
  async load() {
    const before = this.state;
    if (this.retired || before.busy) return;
    this.generation++;
    this.publish({ ...before, busy: 'read', deleteID: undefined, error: undefined, notice: undefined });
    let result: RecordReadResult<T> = { ok: false, error: 'unavailable' };
    try {
      const value = await this.read({ petID: this.petID });
      if (isRecordReadResult(this.validSnapshot, value) && (!value.ok || value.snapshot.revision >= (before.snapshot?.revision ?? 0))) result = value;
    } catch { /* Do not treat inaccessible data as empty. */ }
    if (this.retired) return;
    if (!result.ok) {
      this.publish({ ...before, deleteID: undefined, snapshot: result.error === 'not-found' ? undefined : before.snapshot, needsRead: true, error: result.error, notice: undefined });
      return;
    }
    this.publish({ draft: before.draft, snapshot: result.snapshot, notice: before.needsRead ? 'reloaded' : undefined });
  }
  protected async write(send: (expectedRevision: number) => Promise<RecordWriteResult<T>>, finish?: (draft: D) => D, notice: 'saved' | 'deleted' | 'shared' | 'unshared' = 'saved') {
    const before = this.state;
    if (this.retired || !before.snapshot || before.busy || before.needsRead) return;
    this.generation++;
    this.publish({ ...before, busy: 'write', deleteID: undefined, error: undefined, notice: undefined });
    let result: RecordWriteResult<T> = { ok: false, error: 'write-outcome-unknown' };
    try {
      const value = await send(before.snapshot.revision);
      if (isRecordWriteResult(this.validSnapshot, value, before.snapshot.revision)) result = value;
    } catch { /* Dispatch may already have reached disk. */ }
    if (this.retired) return;
    if (result.ok && result.durability !== 'unconfirmed') {
      this.publish({ snapshot: result.snapshot, draft: finish ? finish(before.draft) : before.draft,
        notice: result.durability === 'unchanged' ? 'unchanged' : notice });
      return;
    }
    const error = result.ok ? 'write-outcome-unknown' : result.error;
    this.publish({ ...before, deleteID: undefined, snapshot: error === 'not-found' ? undefined : before.snapshot, error, notice: undefined,
      needsRead: ['conflict', 'not-found', 'record-not-found', 'write-outcome-unknown', 'unavailable'].includes(error) });
  }
}

export class RecordWorkspace<Session extends { retire(): void; load(): Promise<void> }> {
  private sessions = new Map<string, Session>();
  constructor(private create: (petID: string) => Session) {}
  forPet(petID: string) {
    let session = this.sessions.get(petID);
    if (!session) { session = this.create(petID); this.sessions.set(petID, session); }
    return session;
  }
  refreshExisting(id: string) { void this.sessions.get(id)?.load(); }
  keepRegistered(ids: readonly string[]) {
    const live = new Set(ids);
    for (const [id, session] of this.sessions) if (!live.has(id)) { this.sessions.delete(id); session.retire(); }
  }
}
