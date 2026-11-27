import { useEffect, useRef, useState } from 'react';
import type { LiveRoleId, LiveStageBridge } from '../../../../packages/contracts/src/live-stage.ts';
import { liveSharingLimit, type LiveSharingRow } from '../../../../packages/contracts/src/live-sharing.ts';
import { LiveSharingSession, type LiveSharingState } from '../live-sharing-state.ts';

export function LiveSharing({role,petID,bridge,locked}:{role:LiveRoleId;petID:string|null;bridge?:LiveStageBridge;locked:boolean}){
  const session=useRef<LiveSharingSession|undefined>(undefined);
  const confirmationTrigger=useRef<HTMLButtonElement|null>(null);
  const cancelConfirmation=()=>{setConfirming(undefined);confirmationTrigger.current?.focus();};
  const [opened,setOpened]=useState(false);
  const [state,setState]=useState<LiveSharingState>({phase:'loading'});
  const [confirming,setConfirming]=useState<LiveSharingRow>();
  const available=!!petID&&!!bridge?.readShares&&!!bridge.writeShares;
  useEffect(()=>{
    if(!opened||!petID||!bridge?.readShares||!bridge.writeShares)return;
    const current=new LiveSharingSession({readShares:bridge.readShares,writeShares:bridge.writeShares},role,petID,setState);
    session.current=current;void current.load();
    return()=>{current.dispose();if(session.current===current)session.current=undefined;};
  },[opened,role,petID,bridge]);
  useEffect(()=>{if(locked||state.phase!=='ready')setConfirming(undefined);},[locked,state.phase]);
  const rows=state.snapshot?.records??[];
  const atLimit=rows.filter(r=>r.enabled).length>=liveSharingLimit;
  const disabled=locked||state.phase!=='ready';
  return <section className="interaction-card live-sharing" aria-label="直播资料授权" onKeyDown={event=>{if(event.key==='Escape'&&confirming){event.preventDefault();event.stopPropagation();cancelConfirmation();}}}>
    <div className="module-step-heading"><h2>直播资料授权</h2><button className="interaction-button quiet" type="button" disabled={!available||locked} aria-expanded={opened} onClick={()=>{setConfirming(undefined);setOpened(!opened);}}>{opened?'收起资料':'管理授权'}</button></div>
    <p className="module-copy">仅授权当前绑定实例的已保存身份、已确认且有效的记忆与知识；与在线聊天授权独立。授权内容可能发送给模型服务商，并体现在节目回复中。</p>
    {petID&&!available&&<p className="module-copy">当前环境未接入直播授权管理。</p>}
    {!petID&&<p className="module-copy">请先绑定主播实例。</p>}
    {opened&&available&&<div className="module-stack">
      {state.phase==='loading'&&<p role="status">正在读取直播资料授权…</p>}
      {state.phase==='needs-read'&&<p role="alert">未能确认授权状态，请重新读取，不会自动重试。</p>}
      {state.phase==='saving'&&<p role="status">正在保存授权…</p>}
      <button type="button" className="interaction-button quiet" disabled={locked||state.phase==='saving'||state.phase==='loading'} onClick={()=>{setConfirming(undefined);void session.current?.load();}}>重新读取授权</button>
      {state.phase==='ready'&&rows.length===0&&<p className="module-copy">没有可授权的已保存资料。</p>}
      {state.snapshot&&<div className="module-stack">{rows.map(row=><div className="module-stack" key={`${row.kind}:${row.recordID}:${row.recordRevision}`}>
        <div className="module-step-heading"><span>{row.label} · 版本 {row.recordRevision}</span><span className="badge">{row.enabled?'已授权直播':'仅本机'}</span></div>
        <details><summary>查看当前版本正文</summary><p className="module-copy" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{row.preview}</p></details>
        <button type="button" className="interaction-button quiet" disabled={disabled||(!row.enabled&&atLimit)} onClick={event=>{if(row.enabled){setConfirming(undefined);void session.current?.set(row,false);}else {confirmationTrigger.current=event.currentTarget;setConfirming(row);}}}>{row.enabled?'撤回直播授权':'允许直播使用'}</button>
        {confirming?.recordID===row.recordID&&confirming.recordRevision===row.recordRevision&&!disabled&&!row.enabled&&<div className="module-notice" role="group" aria-label="确认直播授权"><p>确认将此版本用于直播回复？此次仅保存授权，不发送模型请求。</p><div className="button-row"><button type="button" className="button secondary" autoFocus onClick={cancelConfirmation}>取消</button><button type="button" className="button primary" onClick={()=>{setConfirming(undefined);void session.current?.set(row,true);}}>确认直播授权</button></div></div>}
      </div>)}</div>}
      {atLimit&&<p role="status">最多授权 {liveSharingLimit} 项，请先撤回不再需要的授权。</p>}
    </div>}
  </section>;
}
