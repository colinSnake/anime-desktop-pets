import { useEffect, useMemo } from 'react';
import type { DesktopBridge } from '../../../../packages/contracts/src/index.ts';
import type { Memory, RecordSnapshot } from '../../../../packages/contracts/src/character-records.ts';
import { createMemorySession } from './character-record-editors.ts';
import { RecordPanelState, useRecordState } from './RecordPanelState.tsx';

export function learningReviewRecord(snapshot: RecordSnapshot<Memory> | undefined, petID: string, id: string) {
  return snapshot?.petID === petID ? snapshot.records.find(row => row.id === id && row.kind === '偏好') : undefined;
}

/** Uses the existing character repository review/delete workflow, not another approval store. */
export function LiveLearningReview({petID,recordID,characters,locked}:{petID:string;recordID:string;characters?:DesktopBridge['characters'];locked:boolean}) {
  const session = useMemo(() => characters ? createMemorySession(characters,petID) : undefined,[characters,petID]);
  const state = useRecordState(session);
  useEffect(() => () => session?.retire(),[session]);
  const record = learningReviewRecord(state?.snapshot,petID,recordID);
  const disabled = locked || !session || !!state?.busy || !!state?.needsRead;
  const deleting = state?.deleteID === recordID;
  return <section className="module-stack" aria-label="学习偏好人工审核">
    <h3>人工审核</h3>
    <p className="module-copy">候选仅保存在当前实例。确认不等于授权聊天或直播使用；也不会修改身份、知识或目标。</p>
    {!characters ? <p>请在「聊天 → 桌宠 Agent → 记忆」审核这条候选。</p> : <>
      <RecordPanelState state={state} instance={{id:petID}} reload={() => void session?.load()} />
      {record && <><p className="module-record-text">{record.text}</p>
        {record.status === 'candidate' ? <div className="button-row">
          <button type="button" className="button primary" disabled={disabled || deleting} onClick={() => void session?.review(recordID,'confirmMemory')}>确认这条偏好</button>
          <button type="button" className="button secondary" disabled={disabled} onClick={() => session?.requestDelete(recordID)}>拒绝并删除</button>
        </div> : <p role="status">这条偏好已确认；聊天与直播授权仍需分别设置。</p>}
        {deleting && <div role="group" aria-label="确认删除学习候选"><p>确认删除这条候选？</p><div className="button-row">
          <button type="button" className="button secondary" disabled={disabled} onClick={() => session?.cancelDelete()}>取消</button>
          <button type="button" className="button primary" disabled={disabled} onClick={() => void session?.confirmDelete(recordID)}>确认删除</button>
        </div></div>}
      </>}
      {state?.snapshot && !record && <p role="status">此候选已删除或不可用；不会替换为其他记忆。</p>}
    </>}
  </section>;
}
