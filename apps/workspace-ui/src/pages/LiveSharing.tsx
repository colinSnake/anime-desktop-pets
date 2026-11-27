import { useEffect, useRef, useState } from 'react';
import type { LiveRoleId, LiveStageBridge } from '../../../../packages/contracts/src/live-stage.ts';
import { liveSharingLimit, type LiveSharingRow } from '../../../../packages/contracts/src/live-sharing.ts';
import { LiveSharingSession, type LiveSharingState } from '../live-sharing-state.ts';
import { PetNookIcon } from '../PetNookIcon.tsx';
import { LiveSettingsDrawer } from './LiveSettingsDrawer.tsx';

export function LiveSharing({role,petID,bridge,locked,name="主播",onBusy}:{role:LiveRoleId;petID:string|null;bridge?:LiveStageBridge;locked:boolean;name?:string;onBusy?(busy:boolean):void}){
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
  useEffect(()=>{onBusy?.(state.phase==='saving');return()=>onBusy?.(false);},[state.phase,onBusy]);
  const rows=state.snapshot?.records??[];
  const atLimit=rows.filter(r=>r.enabled).length>=liveSharingLimit;
  const disabled=locked||state.phase!=='ready';
  const saving = state.phase === 'saving';
  const count = rows.filter(row => row.enabled).length;
  const summary = !petID ? '绑定后管理' : !available ? '当前环境未接入' : !opened && !state.snapshot ? '点击查看逐项授权' : state.phase === 'needs-read' ? '授权状态待核对' : state.snapshot ? count ? `仅使用明确授权的 ${count} 项资料` : '不使用私有角色资料' : '正在读取授权';
  const close = () => { if (!saving) {setConfirming(undefined);setOpened(false);} };
  return <div className="live-workbench-config-item">
    <button className="live-workbench-config-row" type="button" aria-label={`${name}直播资料授权`} disabled={!available||locked} aria-haspopup="dialog" aria-expanded={opened} onClick={() => {setConfirming(undefined);setOpened(true);}}><span className="live-workbench-config-icon"><PetNookIcon name="lock" /></span><span><strong>直播资料授权</strong><small>{summary}</small></span><span className="live-workbench-state">{!petID?'待绑定':!available?'不可用':state.phase==='needs-read'?'待核对':!state.snapshot?'未读取':count?`${count} 项`:'未授权'}</span><PetNookIcon name="chevron" /></button>
    {opened && <LiveSettingsDrawer title="直播资料授权" subtitle={`${name} · 与聊天授权完全独立`} busy={saving} onClose={close} footer={<><button className="interaction-button quiet" type="button" disabled={locked||saving||state.phase==='loading'} onClick={() => {setConfirming(undefined);void session.current?.load();}}><PetNookIcon name="refresh" />重新读取授权</button><button type="button" className="interaction-button secondary" disabled={saving} onClick={close}>完成</button></>}>
      <div onKeyDown={event=>{if(event.key==='Escape'&&confirming){event.preventDefault();event.stopPropagation();cancelConfirmation();}}}>
        <div className="live-settings-notice"><PetNookIcon name="warning" /><p>仅授权当前实例的已保存身份、已确认且有效的记忆与知识。授权内容可能发送给模型服务商，并体现在直播回复中。默认关闭，与聊天授权独立。</p></div>
        {state.phase==='loading'&&<p role="status">正在读取直播资料授权…</p>}
        {state.phase==='needs-read'&&<p role="alert">未能确认授权状态，请重新读取，不会自动重试。</p>}
        {saving&&<p role="status">正在保存授权…</p>}
        {state.snapshot && (['identity','memory'] as const).map(kind => <section className="live-settings-section live-sharing-group" key={kind}><h3>{kind==='identity'?'身份':'记忆与角色知识'}<small>{kind==='identity'?'已保存版本':'仅已确认且有效的条目'}</small></h3>
          {rows.filter(row=>row.kind===kind).length===0 && <p className="live-sharing-empty">暂无可授权条目</p>}
          {rows.filter(row=>row.kind===kind).map(row=><div className="live-sharing-record" key={`${row.kind}:${row.recordID}:${row.recordRevision}`}>
            <div className="live-sharing-record-heading"><div><strong>{row.label}</strong><small>版本 {row.recordRevision} · {row.enabled?'已授权直播':'仅本机'}</small></div><button type="button" className="live-sharing-toggle" role="switch" aria-label={`${row.enabled?'撤回':'允许'}直播使用：${row.label}`} aria-checked={row.enabled} disabled={disabled||(!row.enabled&&atLimit)} onClick={event=>{if(row.enabled){setConfirming(undefined);void session.current?.set(row,false);}else {confirmationTrigger.current=event.currentTarget;setConfirming(row);}}}><span /></button></div>
            <details><summary>查看当前版本正文</summary><p>{row.preview}</p></details>
            {confirming?.recordID===row.recordID&&confirming.recordRevision===row.recordRevision&&!disabled&&!row.enabled&&<div className="live-settings-confirm" role="group" aria-label="确认直播授权"><strong>允许直播使用此版本的资料？</strong><p>此次仅保存授权，不发送模型请求。资料变更后需重新授权。</p><div className="button-row"><button type="button" className="interaction-button secondary" autoFocus onClick={cancelConfirmation}>取消</button><button type="button" className="interaction-button primary" onClick={()=>{setConfirming(undefined);void session.current?.set(row,true);}}>确认直播授权</button></div></div>}
          </div>)}
        </section>)}
        {atLimit&&<p role="status">最多授权 {liveSharingLimit} 项，请先撤回不再需要的授权。</p>}
      </div>
    </LiveSettingsDrawer>}
  </div>;
}
