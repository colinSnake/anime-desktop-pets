import { useEffect, useId, useState } from 'react';
import { isRecordInput, MEMORY_LIMIT, type Memory } from '../../../../packages/contracts/src/character-records.ts';
import { memoryChangedOnDisk, memoryEditInput, memoryMode, memoryValue, type MemoryForm, type MemoryMode, type MemorySession } from './character-record-editors.ts';
import { RecordPanelState, useRecordState, type RecordInstance } from './RecordPanelState.tsx';
import { DisabledAction, Disclosure, EmptyState, InlineFooter, ModulePage, OptionRow, PageTabs, Panel, PreviewNotice, type Draft } from './WorkspacePanels.tsx';

import { ChatShareControl } from './ChatShareControl.tsx';
import { RecordDeleteConfirmation } from './RecordDeleteConfirmation.tsx';
import { KnowledgeImportPanel } from './KnowledgeImportPanel.tsx';
import { KnowledgeSearchPanel } from './KnowledgeSearchPanel.tsx';
import { isExpired, MemoryFields, recordDetails } from './MemoryFields.tsx';

function MemoryHistory({ session, memory, index, disabled, editing }: {
  session: MemorySession; memory: Memory; index: number; disabled: boolean; editing: boolean;
}) {
  const id = useId();
  const [history, setHistory] = useState<Awaited<ReturnType<MemorySession['readHistory']>> | 'loading'>();
  const [selected, setSelected] = useState<number>();
  const snapshot = typeof history === 'object' && history.ok ? history.snapshot : undefined;
  const preview = snapshot?.history.find(item => item.revision === selected);
  const label = history ? '收起历史' : '查看历史';
  async function toggle() {
    setSelected(undefined);
    if (history) { setHistory(undefined); return; }
    setHistory('loading');
    setHistory(await session.readHistory(memory.id));
  }
  return <div>
    <button className="button secondary" type="button" disabled={disabled || history === 'loading'} aria-label={`${label}，第 ${index + 1} 条`}
      aria-expanded={!!history} aria-controls={id} onClick={() => { void toggle(); }}>{label}</button>
    <div id={id} hidden={!history}>
      {history === 'loading' && <p className="module-copy" role="status">正在读取这条记忆的历史…</p>}
      {typeof history === 'object' && !history.ok && <p className="module-copy" role="alert">
        {history.error === 'conflict' ? '资料已更新，请先读取最新资料。' : history.error === 'unavailable' ? '暂时无法读取这条记忆的历史。' : '这条资料已不可用，请读取最新资料。'}
      </p>}
      {snapshot && (snapshot.history.length ? <>
        <p className="module-copy">选择一个版本预览。</p>
        <div className="module-actions">
          {snapshot.history.slice().reverse().map(item => <button key={item.revision} className="button secondary" type="button" aria-pressed={selected === item.revision}
            onClick={() => setSelected(item.revision)}>第 {item.revision} 版</button>)}
        </div>
        {preview && <div className="module-option">
          <div>
            <strong>第 {preview.revision} 版 · {preview.kind} · {preview.status === 'confirmed' ? '曾确认' : '待确认'}</strong>
            <p className="module-record-text">{preview.text}</p>
            <p>{recordDetails(preview) || '手动记录'}</p>
          </div>
          <InlineFooter hint={editing ? '请先保存或放弃正在编辑的草稿。' : '恢复会创建新版本，需要重新确认。'}>
            <button className="button secondary" type="button" disabled={disabled || editing}
              onClick={() => { void session.restoreHistory(snapshot, preview.revision); }}>恢复此版本</button>
          </InlineFooter>
        </div>}
      </> : <p className="module-copy">这条记忆还没有历史版本。</p>)}
    </div>
  </div>;
}

function MemoryList({ mode, status, state, disabled, session, active }: {
  mode: MemoryMode; status: Memory['status']; state?: ReturnType<MemorySession['getSnapshot']>; disabled: boolean; session?: MemorySession; active: boolean;
}) {
  const pending = status === 'candidate';
  const snapshot = state?.snapshot;
  const editing = state?.draft.editing;
  const matching = snapshot?.records.filter(memory => memoryMode(memory.kind) === mode && memory.status === status);
  return <Panel title={pending ? '待确认' : '已确认'}>
    {matching?.length ? matching.map((memory, index) => {
      const action = pending ? mode === 'knowledge' ? '确认知识' : '确认记忆' : '撤回确认';
      const kind = mode === 'knowledge' ? '知识' : '记忆';
      const confirming = state?.deleteID === memory.id;
      return <section className="module-record" key={memory.id}>
        <p className="module-record-text">{memory.text}</p>
        <OptionRow title={memory.kind} detail={recordDetails(memory) || '手动记录'}>
          <button className="button secondary" type="button" disabled={!session || disabled || editing?.id === memory.id || (pending && isExpired(memory))}
            aria-label={`${action}，第 ${index + 1} 条`}
            onClick={() => { void session?.review(memory.id, pending ? 'confirmMemory' : 'withdrawMemory'); }}>{action}</button>
          {session && <button className="button secondary" type="button" disabled={disabled || !!editing}
            aria-label={`编辑，第 ${index + 1} 条`} onClick={() => session.startEdit(memory.id)}>编辑</button>}
        </OptionRow>
        {session && <Disclosure title={pending ? '历史与删除' : '历史、授权与删除'}>
          <div className="module-actions"><button className="button secondary" type="button" aria-expanded={confirming} aria-label={`删除${kind}，第 ${index + 1} 条`}
            disabled={disabled || editing?.id === memory.id} onClick={() => confirming ? session.cancelDelete() : session.requestDelete(memory.id)}>删除{kind}</button>
            <MemoryHistory key={`${snapshot?.petID}:${session.recordGeneration}`} session={session} memory={memory} index={index} disabled={disabled} editing={!!editing} />
          </div>
          {confirming && <RecordDeleteConfirmation kind={kind} disabled={disabled || editing?.id === memory.id}
          cancel={() => session.cancelDelete()} confirm={() => { void session.confirmDelete(memory.id); }} />}
          {!pending && <ChatShareControl key={`share:${session.petID}:${session.recordGeneration}`} enabled={memory.chatShare === true}
          locked={disabled || confirming || !active} canGrant={editing?.id !== memory.id && !isExpired(memory)}
          scope={mode === 'knowledge' ? '仅在相关且仍有效时授权此条知识的正文和依据' : '仅在相关时授权此条个人记忆的正文'}
          onChange={value => { void session.setChatShare(memory.id, value); }} />}
        </Disclosure>}
      </section>;
    }) : <EmptyState title={snapshot ? pending ? '没有待确认资料' : '没有已确认资料' : pending ? '尚未读取待确认资料' : '尚未读取已确认资料'}
      detail={pending ? '加入的记忆先进入这里，由你逐条确认。' : '撤回确认会把这条资料移回待确认。'} />}
  </Panel>;
}

export function MemoryPage({ mode, onMode, personal, knowledge, connected = false, instance, session }: {
  mode: MemoryMode; onMode(value: MemoryMode): void; personal: Draft<MemoryForm>; knowledge: Draft<MemoryForm>;
  connected?: boolean; instance?: RecordInstance; session?: MemorySession;
}) {
  const state = useRecordState(session);
  useEffect(() => () => session?.cancelDelete(), [session]);
  const snapshot = state?.snapshot;
  const locked = connected && (!snapshot || !!state?.busy || !!state?.needsRead);
  function editor(tab: MemoryMode, fallback: Draft<MemoryForm>) {
    const isKnowledge = tab === 'knowledge';
    const editing = state?.draft.editing;
    const showEdit = !!session && !!state && editing?.mode === tab;
    const draft: Draft<MemoryForm> = showEdit ? {
      value: editing.form, update: update => session.updateEdit(form => typeof update === 'function' ? update(form) : update),
    } : session && state ? { value: state.draft[tab], update: update => session.updateDraft(previous => ({
      ...previous, [tab]: typeof update === 'function' ? update(previous[tab]) : update,
    })) } : fallback;
    const invalidDate = isKnowledge && !memoryValue(draft.value, tab);
    const full = !!snapshot && snapshot.records.length >= MEMORY_LIMIT;
    const canAdd = !!snapshot && !locked && !full && isRecordInput('addMemory', {
      petID: snapshot.petID, expectedRevision: snapshot.revision, draft: memoryValue(draft.value, tab),
    });
    const title = showEdit ? isKnowledge ? '编辑角色知识' : '编辑个人记忆' : isKnowledge ? '添加角色知识' : '添加个人记忆';
    const fields = <>
      <MemoryFields draft={draft} mode={tab} disabled={showEdit ? !!state.busy : locked} />
      {showEdit ? <InlineFooter hint={invalidDate ? '请用 YYYY-MM-DD 填写有效期。' : memoryChangedOnDisk(editing, snapshot) ?
        '已保存的资料有更新或已不可用。可以复制草稿，再放弃编辑。' : '内容修改后需要重新确认。'}>
        <button className="button secondary" type="button" disabled={!!state.busy} onClick={() => session.cancelEdit()}>放弃编辑</button>
        <button className="button primary" type="button" disabled={locked || !memoryEditInput(state)} onClick={() => { void session.saveEdit(); }}>保存修改</button>
      </InlineFooter> : <>
        <InlineFooter hint={invalidDate ? '请用 YYYY-MM-DD 填写有效期。' : full ? '当前实例的记忆已达上限。' : '请勿填入密码、密钥或验证码。'}>
          {connected ? <button className="button primary" type="button" disabled={!canAdd} onClick={() => { void session?.add(tab); }}>加入待确认</button> : <DisabledAction primary>加入待确认</DisabledAction>}
        </InlineFooter>
        {editing && <p className="module-copy">另一分类有正在编辑的草稿。请先在该分类保存或放弃编辑。</p>}
        {isKnowledge && <KnowledgeImportPanel session={session} state={state} active={mode === tab} locked={locked} />}
      </>}
    </>;
    return <>
      {showEdit ? <Panel title={title} focusHeading>{fields}</Panel> : <Disclosure title={title}>{fields}</Disclosure>}
      {isKnowledge && mode === tab && <KnowledgeSearchPanel key={`${session?.petID}:${session?.recordGeneration}`}
        session={session} locked={!connected || locked} />}
      <MemoryList mode={tab} active={mode === tab} status="candidate" state={state} disabled={locked} session={session} />
      <MemoryList mode={tab} active={mode === tab} status="confirmed" state={state} disabled={locked} session={session} />
    </>;
  }
  return <ModulePage title="记忆" description="分开管理个人记忆与角色知识，先审阅，再决定留存。">
    {connected ? <RecordPanelState state={state} instance={instance} reload={session ? () => { void session.load(); } : undefined} /> :
      <PreviewNotice>可试填两类草稿；现有记忆、审核与导入尚未连接，草稿不会保存或在线分享。</PreviewNotice>}
    <PageTabs label="记忆类别" selected={mode} onSelect={next => { if (next !== mode) session?.cancelDelete(); onMode(next); }} items={[
      { id: 'personal', title: '个人记忆', content: editor('personal', personal) },
      { id: 'knowledge', title: '角色知识', content: editor('knowledge', knowledge) },
    ]} />
    <p className="module-copy">确认只影响本机资料。在线聊天授权需逐条开启。</p>
  </ModulePage>;
}
