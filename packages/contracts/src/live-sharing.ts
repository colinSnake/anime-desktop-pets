import { distinct, recordID, within } from './character-records.ts';
import { isLiveRoleId, type LiveRoleId } from './live-stage.ts';
import { petId, revision, shape } from './pets.ts';

export type LiveShareRecord = { kind: 'identity' | 'memory'; recordID: string; recordRevision: number };
export type LiveSharingRow = LiveShareRecord & { enabled: boolean; label: string; preview: string };
export type LiveSharingSnapshot = { role: LiveRoleId; petID: string; bindingRevision: number; revision: number; records: LiveSharingRow[] };
export type LiveSharingInput = { role: LiveRoleId; petID: string; bindingRevision: number; expectedRevision: number; records: LiveShareRecord[] };
export type LiveSharingResult = { ok: true; snapshot: LiveSharingSnapshot } | { ok: false; error: 'unavailable' | 'unbound' | 'conflict' | 'invalid' };
export const liveSharingLimit = 40;
const key = (r: LiveShareRecord) => `${r.kind}:${r.recordID}`;
function isRecord(v: unknown, extras: string[] = []): v is LiveShareRecord {
  return shape(v, ['kind', 'recordID', 'recordRevision', ...extras]) && revision(v.recordRevision) && v.recordRevision > 0 &&
    ((v.kind === 'identity' && v.recordID === 'identity') || (v.kind === 'memory' && recordID(v.recordID)));
}
export function isLiveSharingInput(v: unknown): v is LiveSharingInput {
  return shape(v, ['role', 'petID', 'bindingRevision', 'expectedRevision', 'records']) && isLiveRoleId(v.role) && petId(v.petID) &&
    revision(v.bindingRevision) && revision(v.expectedRevision) && within(v.records, liveSharingLimit, (r): r is LiveShareRecord => isRecord(r)) && distinct(v.records.map(key));
}
function isRow(v: unknown): v is LiveSharingRow {
  return shape(v,['kind','recordID','recordRevision','enabled','label','preview']) &&
    typeof v.enabled === 'boolean' && typeof v.label === 'string' && v.label.length > 0 && v.label.length <= 80 &&
    typeof v.preview === 'string' && v.preview.length <= 140_000 && isRecord(v,['enabled','label','preview']);
}
export function isLiveSharingResult(v: unknown): v is LiveSharingResult {
  if (shape(v,['ok','error']) && v.ok === false) return ['unavailable','unbound','conflict','invalid'].includes(String(v.error));
  if (!shape(v,['ok','snapshot']) || v.ok !== true) return false;
  const s = v.snapshot;
  return shape(s,['role','petID','bindingRevision','revision','records']) && isLiveRoleId(s.role) && petId(s.petID) &&
    revision(s.bindingRevision) && revision(s.revision) && within(s.records,65,isRow) && distinct(s.records.map(key)) &&
    s.records.filter(r=>r.enabled).length <= liveSharingLimit;
}
