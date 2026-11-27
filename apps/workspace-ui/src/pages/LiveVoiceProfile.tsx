import { useEffect, useRef, useState } from 'react';
import { isLiveVoiceProfileResult, isLiveVoiceTranscriptInput, type LiveVoiceProfileResult, type LiveVoiceProfileSnapshot, type LiveVoiceProfileTarget } from '../../../../packages/contracts/src/live-voice-profile.ts';
import type { LiveStageBridge } from '../../../../packages/contracts/src/live-stage.ts';

type VoiceBridge = NonNullable<LiveStageBridge['voiceProfile']>;
const messages:Record<Extract<LiveVoiceProfileResult,{ok:false}>['error'],string>={
  invalid:'参考文件必须是符合要求的 PCM WAV，逐字稿不能超过 4 KiB。',
  conflict:'音色版本已变化，请重新读取再确认。', unbound:'当前角色绑定已变化，请重新读取绑定。',
  cancelled:'已取消选择，原音色未更改。', 'reference-required':'请先选择参考 WAV。',
  storage:'未能确认保存结果，请重新读取；不会自动重试。', unavailable:'音色暂不可用或操作未确认，请重新读取。',
};

export function LiveVoiceProfile({target,bridge,locked,onBusy}:{target?:LiveVoiceProfileTarget;bridge?:VoiceBridge;locked:boolean;onBusy(busy:boolean):void}) {
  const [opened,setOpened]=useState(false);
  const [profile,setProfile]=useState<LiveVoiceProfileSnapshot>();
  const [transcript,setTranscript]=useState('');
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const [confirmClear,setConfirmClear]=useState(false);
  const pending=useRef<symbol|undefined>(undefined);
  useEffect(()=>()=>{pending.current=undefined;onBusy(false);},[onBusy]);
  useEffect(()=>{if(locked)setConfirmClear(false);},[locked]);
  async function perform(action:keyof VoiceBridge){
    if(!target||!bridge||locked||pending.current||(action!=='read'&&!profile))return;
    const input={...target,expectedRevision:profile?.revision??0};
    const ticket=Symbol();pending.current=ticket;setBusy(true);onBusy(true);setNotice('');setConfirmClear(false);
    try {
      const result=await (action==='read'?bridge.read(target):action==='saveTranscript'?bridge.saveTranscript({...input,referenceTranscript:transcript}):bridge[action](input));
      if(pending.current!==ticket)return;
      if(!isLiveVoiceProfileResult(result)||result.ok&&(result.profile.role!==target.role||result.profile.petID!==target.petID||result.profile.bindingRevision!==target.bindingRevision||action!=='read'&&result.profile.revision<input.expectedRevision)) throw new Error('voice_scope');
      if(!result.ok){setNotice(messages[result.error]);if(!['cancelled','invalid','reference-required'].includes(result.error))setProfile(undefined);return;}
      setProfile(result.profile);setTranscript(result.profile.referenceTranscript);
      if(action!=='read')setNotice('已确认当前主播实例的本机音色设置。');
    }catch{if(pending.current===ticket){setProfile(undefined);setNotice(messages.unavailable);}}
    finally{if(pending.current===ticket){pending.current=undefined;setBusy(false);onBusy(false);}}
  }
  const disabled=locked||busy||!profile;
  const valid=!!profile&&isLiveVoiceTranscriptInput({...target,expectedRevision:profile.revision,referenceTranscript:transcript});
  return <section className="interaction-card live-sharing" aria-label="直播音色">
    <div className="module-step-heading"><h2>直播音色</h2><button className="interaction-button quiet" type="button" aria-expanded={opened} disabled={!target||!bridge||locked||busy} onClick={()=>{setOpened(!opened);if(!opened)void perform('read');}}>{opened?'收起音色':'配置本角色音色'}</button></div>
    <p className="module-copy">独立于「语音互动」。停台后为当前绑定实例选择参考 WAV 并保存逐字稿。未配置时仍可开台，但没有节目语音。</p>
    {!target&&<p className="module-copy">请先绑定主播实例。</p>}
    {locked&&opened&&<p className="module-copy">请停台并恢复桌宠联动后再编辑。</p>}
    {opened&&<div className="module-stack">
      <p role="status">{busy?'正在处理音色…':notice||(!profile?'请读取设置。':profile.ready?'音色资料已就绪，将在下次开台时准备声轨。':profile.hasReference?'已选择参考音频，还需保存逐字稿。':'尚未选择参考音频。')}</p>
      <div className="button-row">
        <button type="button" className="button secondary" disabled={locked||busy} onClick={()=>void perform('read')}>重新读取音色</button>
        <button type="button" className="button secondary" disabled={disabled} onClick={()=>void perform('selectReference')}>{profile?.hasReference?'更换参考 WAV':'选择参考 WAV'}</button>
        <button type="button" className="button secondary" disabled={disabled||!profile?.hasReference} onClick={()=>setConfirmClear(true)}>移除参考</button>
      </div>
      {confirmClear&&<div className="module-notice" role="group" aria-label="确认移除直播音色"><p>仅移除应用保存的当前实例音色和逐字稿，不修改原始 WAV。</p><div className="button-row">
        <button type="button" className="button secondary" onClick={()=>setConfirmClear(false)}>取消</button><button type="button" className="button primary" disabled={disabled} onClick={()=>void perform('clearReference')}>确认移除</button>
      </div></div>}
      {profile?.hasReference&&<><label className="module-stack">参考音频逐字稿<textarea rows={3} maxLength={4096} value={transcript} disabled={disabled} onChange={event=>setTranscript(event.currentTarget.value)} /></label>
        <button type="button" className="button primary" disabled={disabled||!valid||transcript===profile.referenceTranscript} onClick={()=>void perform('saveTranscript')}>保存逐字稿</button></>}
    </div>}
  </section>;
}
