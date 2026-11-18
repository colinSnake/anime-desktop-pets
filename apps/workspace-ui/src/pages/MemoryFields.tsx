import { memoryKinds, type Memory } from '../../../../packages/contracts/src/character-records.ts';
import type { MemoryForm, MemoryMode } from './character-record-editors.ts';
import { Choice, Disclosure, Field, patch, type Draft } from './WorkspacePanels.tsx';

export const recordDetails = (memory: Memory) => [memory.source && `来源：${memory.source}`, memory.citation && `引用：${memory.citation}`,
  memory.version && `版本：${memory.version}`, memory.expiresAt && `有效至 ${memory.expiresAt.slice(0, 10)}（UTC）`,
  isExpired(memory) && '已过期'].filter(Boolean).join(' · ');
export const isExpired = (memory: Memory) => !!memory.expiresAt && Date.parse(memory.expiresAt) <= Date.now();

const personalKinds = memoryKinds.filter(kind => kind !== '知识').map(value => ({ value, label: value }));
export function KnowledgeReferenceFields({ draft }: { draft: Draft<MemoryForm> }) {
  return <>
    <Field label="来源（必填）" placeholder="例如：角色设定手册" limit={200} value={draft.value.source} onChange={source => patch(draft, { source })} />
    <Disclosure title="补充引用、版本与有效期"><div className="module-fields two-columns">
      <Field label="引用或位置" limit={500} value={draft.value.citation} onChange={citation => patch(draft, { citation })} />
      <Field label="版本或日期" limit={80} value={draft.value.version} onChange={version => patch(draft, { version })} />
      <Field label="有效期" placeholder="YYYY-MM-DD" limit={10} hint="截至该日期末（UTC）。" value={draft.value.expiresAt} onChange={expiresAt => patch(draft, { expiresAt })} />
    </div></Disclosure>
  </>;
}
export function MemoryFields({ draft, mode, disabled }: { draft: Draft<MemoryForm>; mode: MemoryMode; disabled: boolean }) {
  const knowledge = mode === 'knowledge';
  return <fieldset className="module-stack module-form" disabled={disabled}>
    {!knowledge && <Choice label="类型" value={draft.value.kind} options={personalKinds} onChange={kind => patch(draft, { kind })} />}
    <Field label={knowledge ? '知识正文' : '记忆正文'} placeholder={knowledge ? '写下清晰、可核对的角色知识…' : '例如：我希望先看到方案，再开始实现。'} limit={1000} multiline value={draft.value.text} onChange={text => patch(draft, { text })} />
    {knowledge ? <KnowledgeReferenceFields draft={draft} /> :
      <Field label="来源（可选）" placeholder="例如：手动记录" limit={200} value={draft.value.source} onChange={source => patch(draft, { source })} />}
  </fieldset>;
}
