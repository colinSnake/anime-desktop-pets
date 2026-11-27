import { identitySuggestionForRole, liveRoleForPackage } from '../../../../packages/contracts/src/character-personas.ts';
import {
  identityDraftOf, identityFields, isIdentityResult, isIdentityWriteInput, isIdentityWriteResult,
  type IdentityBridge, type IdentityDraft, type IdentityResult, type IdentitySnapshot, type IdentityWriteError, type IdentityWriteResult,
} from '../../../../packages/contracts/src/characters.ts';
import type { PackageReference } from '../../../../packages/contracts/src/pets.ts';

export const emptyIdentity: IdentityDraft = { name: '', personality: '', speakingStyle: '', relationship: '', role: '', background: '', values: '', motivations: '', knowledgeScope: '', boundaries: '' };
const fields = ['name', ...identityFields] as const;
const savedDraft = (snapshot?: IdentitySnapshot) => snapshot?.identity ? identityDraftOf(snapshot.identity) : emptyIdentity;
export type IdentityEditorState = {
  snapshot?: IdentitySnapshot;
  draft?: IdentityDraft;
  busy?: 'read' | 'save' | 'restore' | 'share';
  error?: IdentityWriteError;
  review?: 'read-required' | 'review-required';
  inspecting?: 'saved' | number;
  notice?: 'suggested' | 'reloaded' | 'saved' | 'restored' | 'unchanged' | 'shared' | 'unshared';
};
export type IdentityInstance = { id: string; package?: PackageReference };
export const emptyIdentityEditorState: IdentityEditorState = Object.freeze({});
export const identityDirty = ({ draft, snapshot }: IdentityEditorState) => !!draft && fields.some(key => draft[key] !== (snapshot?.identity?.[key] ?? ''));
export function identitySuggestionRole({ snapshot, draft, busy, error, review, inspecting }: IdentityEditorState, instance?: IdentityInstance) {
  if (!instance || !snapshot || snapshot.petID !== instance.id || snapshot.identity !== null || !draft ||
    busy || error || review || inspecting !== undefined || fields.some(key => draft[key] !== '')) return undefined;
  return liveRoleForPackage(instance.package);
}

export class IdentityEditor {
  private state = emptyIdentityEditorState;
  private retired = false;
  private listeners = new Set<() => void>();
  constructor(private bridge: IdentityBridge, readonly petID: string) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  private publish(state: IdentityEditorState) {
    if (this.retired) return;
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  retire() { this.publish(emptyIdentityEditorState); this.retired = true; }

  async load() {
    const previous = this.state;
    if (this.retired || previous.busy) return;
    this.publish({ ...previous, busy: 'read', error: undefined, notice: undefined });
    let result: IdentityResult = { ok: false, error: 'unavailable' };
    try {
      const value = await this.bridge.readIdentity({ petID: this.petID });
      if (isIdentityResult(value, this.petID) && (!value.ok || value.snapshot.revision >= (previous.snapshot?.revision ?? 0))) result = value;
    } catch { /* A read failure cannot become an empty profile. */ }
    if (!result.ok) {
      const missing = result.error === 'not-found';
      this.publish({ ...previous, snapshot: missing ? undefined : previous.snapshot,
        draft: missing && !identityDirty(previous) ? undefined : previous.draft, busy: undefined, inspecting: undefined,
        review: missing ? undefined : 'read-required', error: result.error, notice: undefined });
      return;
    }
    const snapshot = result.snapshot;
    const draft = identityDirty(previous) ? previous.draft : savedDraft(snapshot);
    const needsReview = identityDirty({ snapshot, draft }) && (!!previous.review || snapshot.revision !== previous.snapshot?.revision);
    this.publish({ snapshot, draft, ...(needsReview ? { review: 'review-required', inspecting: 'saved' } : {}), notice: previous.snapshot ? 'reloaded' : undefined });
  }

  change(key: keyof IdentityDraft, value: string) {
    const { snapshot, draft, busy, inspecting, error, review } = this.state;
    if (!snapshot || !draft || busy || inspecting !== undefined || review || error === 'not-found') return;
    this.publish({ ...this.state, draft: { ...draft, [key]: value }, error: undefined, notice: undefined });
  }
  applySuggestion(instance: IdentityInstance) {
    if (this.retired) return;
    const role = identitySuggestionRole(this.state, instance);
    if (!role) return;
    const draft = identitySuggestionForRole(role);
    if (draft) this.publish({ ...this.state, draft, notice: 'suggested' });
  }
  discardDraft() {
    const { snapshot, busy, inspecting, review } = this.state;
    if (!snapshot || busy || inspecting !== undefined || review) return;
    this.publish({ snapshot, draft: savedDraft(snapshot) });
  }
  inspectHistory(revision: number) {
    const { snapshot, busy, review } = this.state;
    if (busy || review || !snapshot?.identityHistory.some(item => item.revision === revision)) return;
    this.publish({ ...this.state, inspecting: revision, notice: undefined });
  }
  returnToDraft() {
    const { inspecting, busy, review } = this.state;
    if (busy || inspecting === undefined) return;
    this.publish({ ...this.state, inspecting: undefined, review: review === 'review-required' ? undefined : review, error: undefined });
  }

  save() { return this.write('save'); }
  restore() { return this.write('restore'); }
  setChatShare(enabled: boolean) { return this.write('share', enabled); }
  private async write(action: 'save' | 'restore' | 'share', enabled?: boolean) {
    const { snapshot, draft, busy, review, inspecting } = this.state;
    if (this.retired || !snapshot || !draft || busy || review) return;
    const base = { petID: this.petID, expectedRevision: snapshot.revision };
    let submit: () => Promise<IdentityWriteResult>;
    let validate: (response: unknown) => response is IdentityWriteResult;
    if (action === 'save') {
      const input = { ...base, draft };
      if (inspecting !== undefined || !identityDirty(this.state) || !isIdentityWriteInput('saveIdentity', input)) return;
      submit = () => this.bridge.saveIdentity(input);
      validate = (response): response is IdentityWriteResult => isIdentityWriteResult(response, input);
    } else if (action === 'share') {
      const input = { ...base, enabled };
      const current = snapshot.identity;
      if (!current || inspecting !== undefined || (enabled && identityDirty(this.state)) || !isIdentityWriteInput('setIdentityChatShare', input)) return;
      submit = () => this.bridge.setIdentityChatShare(input);
      validate = (response): response is IdentityWriteResult => isIdentityWriteResult(response, input) &&
        (!response.ok || response.snapshot.identity?.revision === current.revision);
    } else {
      if (typeof inspecting !== 'number' || identityDirty(this.state) || !snapshot.identityHistory.some(item => item.revision === inspecting)) return;
      const input = { ...base, historicalRevision: inspecting };
      submit = () => this.bridge.restoreIdentity(input);
      validate = (response): response is IdentityWriteResult => isIdentityWriteResult(response, input);
    }
    this.publish({ ...this.state, busy: action, error: undefined, notice: undefined });
    let result: IdentityWriteResult = { ok: false, error: 'write-outcome-unknown' };
    try { const value = await submit(); if (validate(value)) result = value; } catch { /* Dispatch may have reached storage. */ }
    if (result.ok && result.durability !== 'unconfirmed') {
      const notice = result.durability === 'unchanged' ? 'unchanged' : action === 'share' ? enabled ? 'shared' : 'unshared' : action === 'save' ? 'saved' : 'restored';
      this.publish({ snapshot: result.snapshot, draft: action === 'share' ? draft : savedDraft(result.snapshot), notice });
      return;
    }
    const error = result.ok ? 'write-outcome-unknown' : result.error;
    this.publish({ ...this.state, snapshot: error === 'not-found' ? undefined : snapshot, busy: undefined, inspecting: undefined, error,
      review: ['conflict', 'history-not-found', 'write-outcome-unknown'].includes(error) ? 'read-required' : undefined });
  }
}

/** Only a mounted workspace owns editors; each instance has independent async state. */
export class IdentityWorkspace {
  private editors = new Map<string, IdentityEditor>();
  constructor(private bridge: IdentityBridge) {}
  forPet(id: string) {
    let editor = this.editors.get(id);
    if (!editor) { editor = new IdentityEditor(this.bridge, id); this.editors.set(id, editor); }
    return editor;
  }
  refreshExisting(id: string) { void this.editors.get(id)?.load(); }
  keepRegistered(ids: readonly string[]) {
    const live = new Set(ids);
    for (const [id, editor] of this.editors) if (!live.has(id)) { this.editors.delete(id); editor.retire(); }
  }
}
