import { isDafeiyu } from '../../../packages/contracts/src/built-in-pets.ts';
import { useId } from 'react';
import { isPetInput, petName } from '../../../packages/contracts/src/pets.ts';
import { isDraftDirty, petDisplayName, type PetDraft, type PetWorkspaceController, type PetWorkspaceState } from './pet-state.ts';
import { petErrorMessages } from './pet-client.ts';
import { SettingsDialog } from './SettingsDialog.tsx';

export function PetSettings({ state, controller, onClose }: {state: PetWorkspaceState; controller?: PetWorkspaceController; onClose(): void}) {
  const prefix = useId();
  const workspace = state.workspace;
  const usesVideo = workspace?.playerMode === 'video';
  const pet = workspace?.instances.find(item => item.id === state.selectedId);
  const companionRole = !!pet && isDafeiyu(pet.package);
  const draft = state.selectedId ? state.drafts[state.selectedId] : undefined;
  const dirty = !!state.selectedId && isDraftDirty(state, state.selectedId);
  const busy = !!state.operation;
  const blocked = busy || state.needsRefresh || !controller;
  const runtimeBlocked = blocked || workspace?.linkage !== 'active' || pet?.phase !== 'running';
  const canSave = !!pet && !!draft && isPetInput('save', {...draft, id:pet.id, expectedRevision:workspace!.revision});
  const edit = (patch: Partial<PetDraft>) => controller?.edit(patch);
  const preference = (key: keyof PetDraft['preferences'], value: boolean | number) => {
    if (draft) edit({preferences:{...draft.preferences,[key]:value}});
  };
  const displayApplied = !!pet?.applied && pet.applied.size === pet.preferences.size && pet.applied.hideInFullscreen === pet.preferences.hideInFullscreen;
  const behaviorApplied = pet?.behavior?.status === 'applied' && pet.behavior.scheduledActivity === pet.preferences.scheduledActivity && pet.behavior.movement === pet.preferences.movement;
  const phaseLabel = pet?.phase === 'running' ? '运行中' : pet?.phase === 'starting' ? '启动中' : pet?.phase === 'stopping' ? '停止中' : pet?.phase === 'failed' ? '运行失败' : '未运行';
  return <SettingsDialog title="桌宠设置" subtitle={`${pet ? petDisplayName(pet, workspace) : '当前实例'} · ${phaseLabel}`} returnFocusId={pet ? `pet-settings-${pet.id}` : undefined} busy={busy} onClose={onClose}>
    <form className="settings-form" onSubmit={event=>{event.preventDefault();if(canSave && dirty && !blocked)void controller?.save();}}>
      <div className="settings-body">
        {!pet && <p className="error" role="alert">这个实例已不在最新清单中。草稿仍保留，请刷新配置。</p>}
        {state.error && <p className="error" role="alert">{petErrorMessages[state.error]}</p>}
        {usesVideo && <p className="muted">{companionRole ? '可应用鲸鱼妹的显示和行为偏好。' : '可应用显示和行为偏好。'}手动显示仍遵守全屏隐藏策略。</p>}
        {draft && <>
          <section className="preference-group" aria-labelledby={`${prefix}-basic`}>
            <h3 id={`${prefix}-basic`}>基本</h3>
            <fieldset className="settings-group" disabled={busy || !controller}><legend className="sr-only">实例配置</legend>
            <div className="field"><label htmlFor={`${prefix}-name`}>桌宠名称</label><input id={`${prefix}-name`} value={draft.displayName} maxLength={160} required aria-invalid={!petName(draft.displayName)} aria-describedby={!petName(draft.displayName)?`${prefix}-name-error`:undefined} autoComplete="off" onChange={event=>edit({displayName:event.target.value})}/>{!petName(draft.displayName) && <small className="error" id={`${prefix}-name-error`}>名称需为 1–80 个字符，不能只含空格或包含控制字符。</small>}</div>
            <Preference id={`${prefix}-enabled`} label="允许启动此实例" detail="关闭后，手动和自动启动均不可用。" checked={draft.enabled} onChange={value=>edit({enabled:value})}/>
            <Preference id={`${prefix}-autostart`} label="随应用启动" detail="保存后，下次打开应用时自动启动。" checked={draft.autoStartOnLaunch} disabled={!draft.enabled} onChange={value=>edit({autoStartOnLaunch:value})}/>
            </fieldset>
          </section>
          <section className="preference-group" aria-labelledby={`${prefix}-display`}>
            <h3 id={`${prefix}-display`}>外观</h3>
            <fieldset className="settings-group" disabled={busy || !controller}><legend className="sr-only">显示偏好</legend>
              <div className="field size-field"><div className="field-heading"><label htmlFor={`${prefix}-size`}>桌宠大小</label><output htmlFor={`${prefix}-size`}>{draft.preferences.size} <small>px</small></output></div><div className="size-slider"><span aria-hidden="true">小</span><input id={`${prefix}-size`} type="range" min="128" max="384" step="1" value={draft.preferences.size} onChange={event=>preference('size',Number(event.target.value))}/><span aria-hidden="true">大</span></div></div>
              <Preference id={`${prefix}-fullscreen`} label="全屏时隐藏" detail="前台进入全屏时收起桌宠。" checked={draft.preferences.hideInFullscreen} onChange={value=>preference('hideInFullscreen',value)}/>
            </fieldset>
            {pet?.phase==='running' && !displayApplied && <div className="preference-application"><span role="status">显示偏好待应用</span><button type="button" className="button secondary compact" disabled={runtimeBlocked || dirty} onClick={()=>{void controller?.applyDisplayPreferences();}}>应用显示偏好</button></div>}
          </section>
          <section className="preference-group" aria-labelledby={`${prefix}-activity`}>
            <h3 id={`${prefix}-activity`}>行为</h3>
            <fieldset className="settings-group" disabled={busy || !controller}><legend className="sr-only">活动偏好</legend><Preference id={`${prefix}-scheduled`} label="自主活动" detail="空闲时可自行切换动作。" checked={draft.preferences.scheduledActivity} onChange={value=>preference('scheduledActivity',value)}/><Preference id={`${prefix}-movement`} label="桌面移动" detail={companionRole ? "和自主活动同时开启时会偶尔走、跑或漂浮；不影响拖拽回弹。" : "允许空闲时自主移动，以及快速松手后延续滑动。"} checked={draft.preferences.movement} onChange={value=>preference('movement',value)}/></fieldset>
            {pet?.phase==='running' && !behaviorApplied && <div className="preference-application"><span role={pet.behavior?.status==='failed'?'alert':'status'}>{pet.behavior?.status==='failed'?'行为应用失败':!pet.behavior?'行为尚未确认':'行为偏好待应用'}</span><button type="button" className="button secondary compact" disabled={runtimeBlocked || dirty} onClick={()=>{void controller?.applyBehaviorPreferences();}}>应用行为偏好</button></div>}
          </section>
        </>}
        {pet && <details className="runtime-details"><summary>运行详情</summary>
          <p><strong>已保存</strong>：{pet.preferences.size} px · 全屏隐藏{pet.preferences.hideInFullscreen?'已开启':'已关闭'}</p>
          <p><strong>运行时已应用</strong>：{pet.applied?`${pet.applied.size} px · 全屏隐藏${pet.applied.hideInFullscreen?'已开启':'已关闭'}`:'尚无可靠确认'}</p>
          <p><strong>已保存行为</strong>：自主活动{pet.preferences.scheduledActivity?'已开启':'已关闭'} · 桌面移动{pet.preferences.movement?'已开启':'已关闭'}</p>
          <p><strong>运行时行为</strong>：{pet.behavior?.status==='applied'?`自主活动${pet.behavior.scheduledActivity?'已开启':'已关闭'} · 桌面移动${pet.behavior.movement?'已开启':'已关闭'}`:pet.behavior?.status==='failed'?'应用失败；尚无可靠确认':'尚无可靠确认'}</p>
          <p><strong>已保存位置</strong>：{pet.preferences.x!==undefined && pet.preferences.y!==undefined?`${pet.preferences.x}, ${pet.preferences.y}`:'尚无位置记录'}</p>
          {pet.positionFeedback && <p><strong>运行时位置</strong>：{pet.positionFeedback.x}, {pet.positionFeedback.y} · {pet.positionFeedback.status==='failed'?'保存失败；保留上次成功位置':pet.positionFeedback.status==='saving'?'正在保存':'已保存'}</p>}
          {pet.phase==='running' && <button type="button" className="button secondary compact" disabled={runtimeBlocked} onClick={()=>{void controller?.setVisible(!pet.applied?.visible);}}>{pet.applied?.visible===false?'显示实例':'隐藏实例'}</button>}
        </details>}
      </div><footer className="save-bar"><span className="muted" role="status">{!pet?'实例未确认':dirty?'有未保存的修改':pet?.phase==='running' && (!displayApplied || !behaviorApplied)?'已保存，运行偏好待应用':'所有设置已保存'}</span><div className="button-row"><button type="button" className="button secondary" disabled={!dirty || busy || !pet || !controller} onClick={()=>controller?.discard()}>还原</button><button type="submit" className="button primary" disabled={blocked || !dirty || !canSave}>{state.operation==='save'?'保存中…':'保存设置'}</button></div></footer>
    </form>
  </SettingsDialog>;
}
function Preference({id,label,detail,checked,disabled,onChange}:{id:string;label:string;detail:string;checked:boolean;disabled?:boolean;onChange(value:boolean):void}) {
  return <div className="preference-row"><div><label htmlFor={id}>{label}</label><small id={`${id}-help`}>{detail}</small></div><input className="toggle" type="checkbox" id={id} aria-describedby={`${id}-help`} checked={checked} disabled={disabled} onChange={event=>onChange(event.target.checked)}/></div>;
}
