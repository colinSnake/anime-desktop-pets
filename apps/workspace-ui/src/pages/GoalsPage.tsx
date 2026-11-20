import { useEffect } from 'react';
import { goalStatuses, goalStepLimit, GOAL_LIMIT, isRecordInput, type Goal } from '../../../../packages/contracts/src/character-records.ts';
import type { WorkspaceData } from '../../../../packages/contracts/src/pets.ts';
import { emptyGoal, goalChangedOnDisk, goalFormOf, goalValue, type GoalForm, type GoalSession, type GoalStepForm } from './character-record-editors.ts';
import { ChatShareControl } from './ChatShareControl.tsx';
import { RecordDeleteConfirmation } from './RecordDeleteConfirmation.tsx';
import { RecordPanelState, useRecordState, type RecordInstance } from './RecordPanelState.tsx';
import { Choice, DisabledAction, Disclosure, EmptyState, Field, InlineFooter, ModulePage, OptionRow, PageTabs, Panel, PreviewNotice, patch, type Draft } from './WorkspacePanels.tsx';

export type GoalMode = 'capabilities' | 'plan';
const statuses = goalStatuses.map(value => ({ value, label: value }));
function GoalList({ records, locked, draft, deleteID, session }: {
  records?: Goal[]; locked: boolean; draft: Draft<GoalForm>; deleteID?: string; session?: GoalSession;
}) {
  return <Panel title="已保存的目标">
    {records?.length ? records.map(goal => <section className="module-record" key={goal.id}>
      <OptionRow title={goal.title} detail={`${goal.status} · ${goal.steps.filter(step => step.isComplete).length} / ${goal.steps.length} 步已完成`}>
        <button type="button" className="button secondary" aria-label={`编辑目标：${goal.title}`} disabled={locked || draft.value.changed || !session} onClick={() => draft.update(goalFormOf(goal))}>编辑目标</button>
        {session && <button type="button" className="button secondary" aria-expanded={deleteID === goal.id} aria-label={`删除目标：${goal.title}`}
          disabled={locked || draft.value.editing?.id === goal.id} onClick={() => deleteID === goal.id ? session.cancelDelete() : session.requestDelete(goal.id)}>删除目标</button>}
      </OptionRow>
      {session && deleteID === goal.id && <RecordDeleteConfirmation kind="目标" disabled={locked || draft.value.editing?.id === goal.id}
        cancel={() => session.cancelDelete()} confirm={() => { void session.confirmDelete(goal.id); }} />}
      {session && <ChatShareControl key={`${session.petID}:${session.recordGeneration}`} enabled={goal.chatShare === true}
        locked={locked || deleteID === goal.id} canGrant={draft.value.editing?.id !== goal.id}
        scope="仅在相关时授权此目标的名称、状态和完成步数" onChange={value => { void session.setChatShare(goal.id, value); }} />}
      <Disclosure title="查看已保存计划">
        {goal.details && <p className="module-record-text">{goal.details}</p>}
        {goal.steps.length ? <ol className="module-step-list">{goal.steps.map(step => <li className="module-record-text" key={step.id}>{step.isComplete ? '已完成：' : '待完成：'}{step.text}</li>)}</ol> :
          <p className="module-copy">此目标暂无步骤。</p>}
      </Disclosure>
    </section>) : <EmptyState title={records ? '还没有已保存的目标' : '尚未读取目标'} detail="这里显示各目标已保存的进度。" />}
  </Panel>;
}

function GoalEditor({ draft, records, connected, locked, stale, canSave, save, deleteID, session }: {
  draft: Draft<GoalForm>; records?: Goal[]; connected: boolean; locked: boolean; stale: boolean; canSave: boolean; save?(): void; deleteID?: string; session?: GoalSession;
}) {
  const editStep = (key: number, changes: Partial<Pick<GoalStepForm, 'text' | 'done'>>) => draft.update(previous => ({ ...previous, changed: true,
    steps: previous.steps.map(step => step.key === key ? { ...step, ...changes } : step) }));
  const fields = <>
    {stale && <p role="alert" className="error">已保存的目标有更新或已不可用。草稿仍在，请先核对；放弃草稿后可重新打开已保存版本。</p>}
    <fieldset className="module-stack module-form" disabled={locked}>
      <Field label="目标名称" placeholder="例如：每周整理一次学习笔记" limit={120} value={draft.value.title} onChange={title => patch(draft, { title, changed: true })} />
      <Field label="目标说明" limit={2000} multiline value={draft.value.detail} onChange={detail => patch(draft, { detail, changed: true })} />
      <Choice label="进度状态" value={draft.value.status} options={statuses} onChange={status => patch(draft, { status, changed: true })} />
      <section className="module-step-section" aria-label="目标步骤">
        <div className="module-step-heading"><h3>步骤</h3><span className="badge">{draft.value.steps.filter(step => step.done).length} / {draft.value.steps.length} 已完成</span></div>
        {!draft.value.steps.length && <p className="module-copy">可以把目标拆成几个容易检查的步骤。</p>}
        {!!draft.value.steps.length && <ol className="module-step-list">{draft.value.steps.map((step, index) => <li key={step.key}>
          <Field label={`步骤 ${index + 1}`} limit={500} value={step.text} onChange={text => editStep(step.key, { text })} />
          <div className="module-step-actions"><label><input type="checkbox" checked={step.done} onChange={event => editStep(step.key, { done: event.currentTarget.checked })} />步骤 {index + 1} 已完成</label>
            <button className="text-button" type="button" aria-label={`移除步骤 ${index + 1}`} onClick={() => draft.update(previous => ({ ...previous, changed: true, steps: previous.steps.filter(item => item.key !== step.key) }))}>移除</button></div>
        </li>)}</ol>}
        <button className="button secondary" type="button" disabled={draft.value.steps.length >= goalStepLimit} onClick={() => draft.update(previous => previous.steps.length >= goalStepLimit ? previous :
          ({ ...previous, changed: true, nextStep: previous.nextStep + 1, steps: [...previous.steps, { key: previous.nextStep, text: '', done: false }] }))}>添加步骤</button>
      </section>
    </fieldset>
    <InlineFooter hint={records && records.length >= GOAL_LIMIT && !draft.value.editing ? '当前实例的目标已达上限。' : '更改只影响草稿，不会触发后台执行。'}>
      {connected ? <>
        {(draft.value.changed || draft.value.editing) && <button type="button" className="button secondary" disabled={locked} onClick={() => draft.update(emptyGoal)}>{draft.value.changed ? '放弃草稿' : '新建草稿'}</button>}
        <button type="button" className="button primary" disabled={!canSave} onClick={save}>保存目标</button>
      </> : <DisabledAction primary>保存目标</DisabledAction>}
    </InlineFooter>
  </>;
  return <>
    {draft.value.editing ? <Panel title="编辑目标" focusHeading>{fields}</Panel> : <Disclosure title="添加目标">{fields}</Disclosure>}
    <GoalList records={records} locked={locked} draft={draft} deleteID={deleteID} session={session} />
  </>;
}

function Capabilities({ workspace, connected }: { workspace?: WorkspaceData; connected: boolean }) {
  const linkage = workspace?.linkage;
  const label = linkage ? { active: '未暂停', pausing: '正在暂停', paused: '已暂停', 'stop-unconfirmed': '停止未确认' }[linkage] : '尚未读取';
  return <>
    <Panel title="工作区状态">
      <OptionRow title="桌宠联动" detail={workspace ? `已配置 ${workspace.instances.length} 个实例。` : '正在等待工作区状态。'}><span className="badge">{label}</span></OptionRow>
      <OptionRow title="本机角色资料" detail={connected ? '可管理当前实例的记忆和目标。' : '当前工作区无法读取角色资料。'} />
    </Panel>
    <Disclosure title="功能与授权范围">
      <OptionRow title="在线文字聊天" detail="使用已保存的模型路由；身份、记忆、知识及目标须分别授权。" />
      <OptionRow title="气泡播报" detail="可在兼容的 Mac 上为本次会话启用；麦克风和语音对话尚未接入。" />
      <OptionRow title="任务与直播" detail="Codex 任务阶段可驱动自有桌宠动画；直播平台尚未接入。目标计划仅手动更新。" />
    </Disclosure>
  </>;
}

export function GoalsPage({ mode, onMode, draft: fallback, workspace, connected = false, instance, session, planOnly = false }: {
  mode: GoalMode; onMode(mode: GoalMode): void; draft: Draft<GoalForm>; workspace?: WorkspaceData;
  connected?: boolean; instance?: RecordInstance; session?: GoalSession; planOnly?: boolean;
}) {
  const state = useRecordState(session), snapshot = state?.snapshot;
  useEffect(() => () => session?.cancelDelete(), [session]);
  const draft = session && state ? { value: state.draft, update: session.updateDraft } : fallback;
  const locked = connected && (!snapshot || !!state?.busy || !!state?.needsRead);
  const stale = !!snapshot && goalChangedOnDisk(draft.value, snapshot);
  const input = { petID: snapshot?.petID, expectedRevision: snapshot?.revision, draft: goalValue(draft.value) };
  const canSave = !!snapshot && !locked && !stale && draft.value.changed && (draft.value.editing ?
    isRecordInput('editGoal', { ...input, id: draft.value.editing.id }) : snapshot.records.length < GOAL_LIMIT && isRecordInput('addGoal', input));
  const plan = <>
    {connected && <RecordPanelState state={state} instance={instance} reload={session ? () => { void session.load(); } : undefined} />}
    <GoalEditor draft={draft} records={snapshot?.records} locked={locked} stale={stale} connected={connected} canSave={canSave} deleteID={state?.deleteID} session={session} save={() => { void session?.save(); }} />
  </>;
  if (planOnly) return <ModulePage title="目标" description="查看已保存的计划，手动更新目标和步骤进度。">{plan}</ModulePage>;
  return <ModulePage title="能力与目标" description="查看角色能做的事，整理你想和它一起跟进的计划。">
    {!connected && <PreviewNotice>目标和步骤可试填；尚未接入角色资料，草稿不会改变角色行为。</PreviewNotice>}
    <PageTabs label="能力与目标" selected={mode} onSelect={next => { if (next !== mode) session?.cancelDelete(); onMode(next); }} items={[
      { id: 'capabilities', title: '可用能力', content: <Capabilities workspace={workspace} connected={connected} /> },
      { id: 'plan', title: '目标计划', content: plan },
    ]} />
  </ModulePage>;
}
