import { useId, useState } from 'react';
import type { PetPhase } from '../../../packages/contracts/src/pets.ts';
import { PetCover } from './PetCover.tsx';
import { PetCardMore } from './PetCardMore.tsx';
import { PetSettings } from './PetSettings.tsx';
import { isDraftDirty, petDisplayName, type PetWorkspaceController, type PetWorkspaceState } from './pet-state.ts';

const phaseNames: Record<PetPhase,string> = {'not-connected':'未接入播放器',stopped:'已停止',starting:'启动中',running:'运行中',stopping:'停止中',failed:'运行失败'};
export function PetPage({state,controller}:{state:PetWorkspaceState;controller?:PetWorkspaceController}) {
  const [showCatalog,setShowCatalog]=useState(false);
  const [showSettings,setShowSettings]=useState(false);
  const catalogId=useId();
  const workspace=state.workspace;
  const entries=workspace?.instances??[];
  const catalog=workspace?.catalog??[];
  const busy=!!state.operation;
  const blocked=busy||state.needsRefresh||!controller;
  const atLimit=entries.length>=32;
  // Card actions select synchronously before issuing the fixed ID-only command.
  const target=(id:string,action:()=>void)=>{if(!busy && controller){controller.select(id);action();}};
  return <>
    <header className="page-heading pet-page-heading"><h1>我的桌宠 <span className="pet-count">{entries.length}</span></h1><div className="button-row"><button className="button secondary compact" disabled={busy||!controller} onClick={()=>{void controller?.load();}}>{state.operation==='load'?'读取中…':'刷新'}</button><button className="button primary compact" aria-expanded={showCatalog} aria-controls={catalogId} disabled={blocked||atLimit} onClick={()=>setShowCatalog(value=>!value)}>添加桌宠</button></div></header>
    {workspace && <section className="pet-toolbar" aria-label="桌宠控制"><strong>桌宠控制</strong><button className="button secondary compact" disabled={blocked||workspace.linkage==='pausing'} onClick={()=>{void controller?.controlLinkage(workspace.linkage==='paused'?'resume':'pause');}}>{workspace.linkage==='paused'?'解除暂停':workspace.linkage==='stop-unconfirmed'?'重试暂停':workspace.linkage==='pausing'?'正在暂停…':'暂停联动'}</button>{workspace.linkage==='paused' && <span className="muted">已暂停，解除后需逐个手动启动</span>}{workspace.linkage==='stop-unconfirmed' && <span className="error" role="alert">停止未确认，门禁保持关闭</span>}</section>}
    {state.runtimeStale && <p className="error" role="alert">运行状态刷新失败，请刷新后核对。</p>}
    {showCatalog && <section id={catalogId} className="catalog-panel" aria-label="添加桌宠"><div className="catalog-heading"><h2>选择桌宠</h2><button className="button secondary compact" disabled={blocked||catalog.length>=32} onClick={()=>{void controller?.importPackages();}}>{state.operation==='importPackages'?'正在校验…':'导入素材'}</button></div>{state.notice&&<p className="catalog-feedback" role="status" aria-live="polite">{state.notice}</p>}{catalog.length>0?<ul>{catalog.map(entry=><li key={`${entry.id}@${entry.version}`}><div><strong>{entry.name}</strong>{entry.launchable===false&&<small>已导入；当前播放器暂不支持启动</small>}</div><button className="button secondary compact" disabled={blocked||atLimit} onClick={()=>{void controller?.add({id:entry.id,version:entry.version}).then(success=>{if(success)setShowCatalog(false);});}}>添加「{entry.name}」</button></li>)}</ul>:<p>还没有可添加的桌宠素材。</p>}</section>}
    {entries.length ? <ul className="pet-grid" aria-label="桌宠实例列表">{entries.map(pet=>{
      const name=petDisplayName(pet,workspace);
      const stopped=['stopped','not-connected'].includes(pet.phase);
      const packageEntry=workspace?.catalog.find(entry=>entry.id===pet.package.id&&entry.version===pet.package.version);
      const canStart=pet.phase==='stopped'&&pet.enabled&&packageEntry?.launchable!==false&&workspace?.linkage==='active';
      const label=stopped?'启动':pet.phase==='starting'?'取消启动':pet.phase==='failed'?'确认停止':pet.phase==='stopping'?'等待退出…':'停止';
      return <li key={pet.id}><article className={`pet-card phase-${pet.phase}`} aria-label={name}>
        <div className="pet-card-cover"><PetCover reference={pet.package}/><div className="pet-card-labels"><strong title={name}>{name}</strong><span className="pet-phase"><span className="status-dot" aria-hidden="true"/>{phaseNames[pet.phase]}</span></div></div>
        <div className="pet-card-actions"><button className={`button compact${pet.phase==='running'?' primary':' secondary'}`} disabled={blocked||pet.phase==='stopping'||(stopped&&!canStart)} onClick={()=>target(pet.id,()=>{void controller?.control(stopped?'start':'stop');})}>{label}</button><button className="button secondary compact" id={`pet-settings-${pet.id}`} aria-label={`设置${name}`} onClick={()=>target(pet.id,()=>setShowSettings(true))} disabled={busy||!controller}>设置</button><PetCardMore name={name} disabled={blocked} cloneDisabled={blocked||atLimit} deleteDisabled={blocked||!stopped} onClone={()=>target(pet.id,()=>{void controller?.clone();})} onDelete={()=>target(pet.id,()=>controller?.requestDelete())}/></div>
        {isDraftDirty(state,pet.id)&&<p className="draft-marker card-draft">未保存</p>}
        {pet.phase==='failed' && <p className="card-error" role="alert">运行失败，请确认停止后重试。</p>}
        {packageEntry?.launchable===false&&<p className="card-error">素材已导入，播放器暂不支持启动。</p>}
        {pet.positionFeedback?.status==='failed' && <p className="card-error" role="alert">位置保存失败，保留上次成功位置。</p>}
        {pet.behavior?.status==='failed' && <p className="card-error" role="alert">行为应用失败，请在设置中重试。</p>}
      </article></li>;
    })}</ul> : <div className="pet-empty"><p>{workspace?'还没有桌宠，添加一只开始陪伴。':'尚未连接桌面宿主。'}</p></div>}
    {showSettings&&<PetSettings state={state} controller={controller} onClose={()=>setShowSettings(false)}/>}
  </>;
}
