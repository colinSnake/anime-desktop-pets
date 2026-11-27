import { useEffect, useRef, useState } from 'react';
import type { DesktopBridge } from '../../../../packages/contracts/src/index.ts';
import type { CharacterLearningBridge } from '../../../../packages/contracts/src/character-learning.ts';
import type { LiveLearningHandle, LiveRoleId } from '../../../../packages/contracts/src/live-stage.ts';
import { LiveLearningSession, type LiveLearningState } from '../live-learning-state.ts';
import { LiveLearningReview } from './LiveLearningReview.tsx';

export function LiveLearning({bridge,handle,role,locked,characters,onUnknown}:{bridge:Pick<CharacterLearningBridge,'preview'|'generate'|'cancel'>;handle:LiveLearningHandle;role:LiveRoleId;locked:boolean;characters?:DesktopBridge['characters'];onUnknown():void}) {
  const [state,setState]=useState<LiveLearningState>({phase:'idle'});
  const [dismissed,setDismissed]=useState(false);
  const [cancelPending,setCancelPending]=useState(false);
  const session=useRef<LiveLearningSession|undefined>(undefined);
  useEffect(()=>{
    const owned=new LiveLearningSession(bridge,role,{petID:handle.petID,ticket:handle.ticket},setState);session.current=owned;
    const hidden=()=>{
      if(!document.hidden)return;
      void owned.dispose();setState({phase:'idle'});setDismissed(true);setCancelPending(false);
    };
    document.addEventListener('visibilitychange',hidden);
    return ()=>{document.removeEventListener('visibilitychange',hidden);if(session.current===owned)session.current=undefined;void owned.dispose();};
  },[bridge,handle.petID,handle.ticket,role]);
  useEffect(()=>{
    if(state.phase==='review'||cancelPending||state.error==='write-outcome-unknown')return;
    const timer=setTimeout(()=>{void session.current?.dispose();setDismissed(true);setState({phase:'idle'});},Math.max(0,handle.expiresAt-Date.now()));
    return ()=>clearTimeout(timer);
  },[handle.expiresAt,state.phase,state.error,cancelPending]);
  async function cancel(){
    const owned=session.current;
    const generating=owned?.state.phase==='generating';
    const stopping=owned?.dispose();
    setState({phase:'idle'});
    if(!generating){setDismissed(true);return;}
    setCancelPending(true);
    const result=await stopping;
    if(!result?.ok)onUnknown();
    if(session.current!==owned||document.hidden)return;
    setCancelPending(false);setDismissed(true);
  }
  if(dismissed)return null;
  return <div className="live-learning module-stack">
    {cancelPending&&<p role="status">正在取消学习…</p>}
    {!cancelPending&&state.phase==='idle'&&<button type="button" className="interaction-button quiet" disabled={locked} onClick={()=>void session.current?.select()}>从本轮演练提议偏好</button>}
    {state.phase==='loading'&&<p role="status">正在读取所选一轮…</p>}
    {state.phase==='preview'&&state.preview&&<div className="module-notice" role="group" aria-label="确认只学习这一轮演练">
      <p>仅发送下列一轮给已保存的默认模型（可能计费），最多生成一条待审核的表达偏好。不会发送其他历史或角色资料。</p>
      <p className="module-record-text"><strong>弹幕：</strong>{state.preview.user}</p>
      <p className="module-record-text"><strong>回复：</strong>{state.preview.assistant}</p>
      <div className="button-row"><button type="button" className="button secondary" autoFocus onClick={()=>void cancel()}>取消</button>
        <button type="button" className="button primary" disabled={locked} onClick={()=>void session.current?.confirm()}>确认生成候选</button></div>
    </div>}
    {state.phase==='generating'&&<div className="button-row"><p role="status">正在生成一条待审核偏好…</p><button type="button" className="button secondary" onClick={()=>void cancel()}>取消学习</button></div>}
    {state.phase==='failed'&&<p role="status">{state.error==='write-outcome-unknown'||state.error==='unavailable'?'未能确认候选是否保存。请到「聊天 → 桌宠 Agent → 记忆」核对，不会自动重试。':state.error==='expired'||state.error==='conflict'?'本轮已过期或资料版本已变化，请选择新一轮。':state.error==='duplicate'?'已有同样的偏好候选或记忆，未重复保存。':'未生成可审核的表达偏好。'}</p>}
    {state.phase==='review'&&state.candidateID&&<LiveLearningReview petID={handle.petID} recordID={state.candidateID} locked={locked} characters={characters} />}
  </div>;
}
