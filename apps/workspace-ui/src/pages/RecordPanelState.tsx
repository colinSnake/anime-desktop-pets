import { useEffect, useSyncExternalStore } from 'react';
import type { CharacterRecord, RecordError } from '../../../../packages/contracts/src/character-records.ts';
import type { RecordSession, RecordState } from './record-session.ts';

const idle = () => () => {};
export function useRecordState<T extends CharacterRecord, D extends object>(session?: RecordSession<T, D>) {
  const state = useSyncExternalStore(session?.subscribe ?? idle, session?.getSnapshot ?? missing, session?.getSnapshot ?? missing);
  useEffect(() => {
    if (session && !session.getSnapshot().snapshot && !session.getSnapshot().error) void session.load();
  }, [session]);
  return state;
}
const missing = () => undefined;
const messages: Record<RecordError, string> = {
  'not-found': '这个实例已不在工作区，请重新选择。', 'record-not-found': '这条记录已不可用，请重新读取。',
  unavailable: '暂时无法访问本机资料。', invalid: '资料格式或步骤不符合要求，请检查后重试。',
  limit: '资料达到存储上限。', conflict: '资料版本已变化。草稿已保留，请先重新读取。', busy: '资料正在使用，请稍后重试。',
  'write-outcome-unknown': '上次保存结果未确认。请先重新读取，核对已保存的记录后再操作。',
  'credential-like': '该资料可能包含凭证，操作未保存。请移除相关内容。', expired: '这条知识已过有效期，无法确认。',
  duplicate: '已有内容相同的已确认记录。', 'knowledge-conflict': '同一来源、引用和版本已有不同的已确认知识，请核对依据。',
};
export type RecordInstance = { id: string; displayName?: string };
export function RecordPanelState({ state, instance, reload }: { state?: Pick<RecordState<CharacterRecord, object>, 'error' | 'busy' | 'snapshot' | 'notice'>; instance?: RecordInstance; reload?: () => void }) {
  const text = !instance ? '请先在「我的桌宠」选择一个实例。' : state?.busy === 'write' ? '正在保存本机资料…' : state?.busy === 'read' || (!state?.snapshot && !state?.error) ? '正在读取本机资料…' :
    state?.error ? '' : state?.notice === 'shared' ? '已保存在线聊天授权。' : state?.notice === 'unshared' ? '已撤回在线聊天授权。' :
      state?.notice === 'deleted' ? '已删除所选资料。' : state?.notice === 'saved' ? '已保存到当前实例。' : state?.notice === 'unchanged' ? '资料没有变化。' :
      state?.notice === 'reloaded' ? '已重新读取。请核对列表后再提交草稿。' : '只管理当前实例的本机资料。';
  return <aside className="module-notice" aria-label="本机资料状态">
    {instance && <strong>{instance.displayName || '当前实例'}</strong>}
    <p role="status">{text}</p>{state?.error && <p role="alert" className="error">{messages[state.error]}</p>}
    {reload && !state?.busy && state?.error !== 'not-found' && (state?.snapshot || state?.error) &&
      <button className="button secondary" type="button" onClick={reload}>读取最新资料</button>}
  </aside>;
}
