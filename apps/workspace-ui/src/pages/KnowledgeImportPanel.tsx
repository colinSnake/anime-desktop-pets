import { useEffect, useRef, useState } from 'react';
import type { KnowledgeFileResult } from '../../../../packages/contracts/src/knowledge-import.ts';
import { prepareKnowledgeImport, type MemoryForm, type MemorySession } from './character-record-editors.ts';
import { KnowledgeReferenceFields } from './MemoryFields.tsx';
import { DisabledAction, Disclosure, InlineFooter, OptionRow, type Draft } from './WorkspacePanels.tsx';

type PickerError = Extract<KnowledgeFileResult, { ok: false }>['error'];
const pickerMessages: Record<Exclude<PickerError, 'cancelled'>, string> = {
  busy: '文件选择器正在使用。', 'invalid-file': '请选择一个可读取的 .txt 或 .md 普通文件。',
  'invalid-text': '文件须为非空 UTF-8 文本，每段最多 1,000 字符。', limit: '文件不能超过 32 KiB 或 50 段。',
  'credential-like': '文件可能包含凭证，未打开预览。', unavailable: '暂时无法读取所选文件。',
};
const previewMessages = {
  invalid: '请缩短来源、引用或版本；引用需为分段标记留出空间。', source: '请先填写知识来源。', date: '请用 YYYY-MM-DD 填写有效期。',
  limit: '当前实例剩余记忆位置不足。', expired: '有效期已过，请先更新。', 'credential-like': '资料可能包含凭证，不能加入。',
  duplicate: '批内或当前实例已有相同知识，请核对后选择不重复的文件。',
  'knowledge-conflict': '同一来源、引用位置和版本已有其他内容，请核对依据。',
};
export function KnowledgeImportPanel({ session, state, active, locked }: {
  session?: MemorySession; state?: ReturnType<MemorySession['getSnapshot']>; active: boolean; locked: boolean;
}) {
  const request = useRef<object | undefined>(undefined);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<Exclude<PickerError, 'cancelled'>>();
  useEffect(() => { setChoosing(false); setError(undefined); return () => { request.current = undefined; }; }, [session, active]);
  const preview = state?.draft.knowledgeImport;
  async function choose() {
    if (!session || !active || request.current) return;
    const id = {};
    request.current = id;
    setChoosing(true); setError(undefined);
    const result = await session.chooseKnowledgeFile(() => request.current === id);
    if (request.current !== id) return;
    request.current = undefined;
    setChoosing(false);
    if (result && !result.ok && result.error !== 'cancelled') setError(result.error);
  }
  if (!preview || !state || !session) return <>
    <OptionRow title="导入知识" detail="选择 .txt 或 .md，先核对分段与来源，再加入待确认。">
      {session ? <button className="button secondary" type="button" disabled={locked || choosing || !active}
        onClick={() => { void choose(); }}>选择文本文件</button> : <DisabledAction>选择文本文件</DisabledAction>}
    </OptionRow>
    {choosing && <p className="module-copy" role="status">正在选择或读取文本…</p>}
    {error && <p className="error" role="alert">{pickerMessages[error]}</p>}
  </>;
  const { paragraphs, form } = preview;
  const draft: Draft<MemoryForm> = { value: form, update: update => session.updateKnowledgeImport(value => typeof update === 'function' ? update(value) : update) };
  const prepared = prepareKnowledgeImport(state);
  return <div className="module-stack" aria-label="导入知识预检">
    <OptionRow title={`预检 ${paragraphs.length} 段`} detail="逐段展开核对。加入后仍需逐条确认，文件内容不会覆盖现有资料。" children={null} />
    {paragraphs.map((paragraph, index) => <Disclosure key={index} title={`第 ${index + 1} 段`}><p className="module-record-text">{paragraph}</p></Disclosure>)}
    <fieldset className="module-stack module-form" disabled={!!state.busy}><KnowledgeReferenceFields draft={draft} /></fieldset>
    <InlineFooter hint={'issue' in prepared ? previewMessages[prepared.issue] : '如填写引用，保存时会为每段注明位置。'}>
      <button className="button secondary" type="button" disabled={!!state.busy} onClick={() => session.cancelKnowledgeImport()}>放弃预检</button>
      <button className="button primary" type="button" disabled={locked || 'issue' in prepared} onClick={() => { void session.saveKnowledgeImport(); }}>将 {paragraphs.length} 段加入待确认</button>
    </InlineFooter>
  </div>;
}
