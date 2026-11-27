import { useEffect, useRef, useState } from 'react';
import { isLiveVoiceProfileResult, isLiveVoiceTranscriptInput, type LiveVoiceProfileResult, type LiveVoiceProfileSnapshot, type LiveVoiceProfileTarget } from '../../../../packages/contracts/src/live-voice-profile.ts';
import type { LiveStageBridge } from '../../../../packages/contracts/src/live-stage.ts';
import { PetNookIcon } from '../PetNookIcon.tsx';
import { LiveSettingsDrawer } from './LiveSettingsDrawer.tsx';

type VoiceBridge = NonNullable<LiveStageBridge['voiceProfile']>;
const messages:Record<Extract<LiveVoiceProfileResult,{ok:false}>['error'],string>={
  invalid:'参考文件必须是符合要求的 PCM WAV，逐字稿不能超过 4 KiB。',
  conflict:'音色版本已变化，请重新读取再确认。', unbound:'当前角色绑定已变化，请重新读取绑定。',
  cancelled:'已取消选择，原音色未更改。', 'reference-required':'请先选择参考 WAV。',
  storage:'未能确认保存结果，请重新读取；不会自动重试。', unavailable:'音色暂不可用或操作未确认，请重新读取。',
};

export function LiveVoiceProfile({target,bridge,locked,onBusy,name="主播",instanceName=name}:{target?:LiveVoiceProfileTarget;bridge?:VoiceBridge;locked:boolean;onBusy(busy:boolean):void;name?:string;instanceName?:string}) {
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
  const summary = !target ? '绑定后配置' : !bridge ? '当前环境未接入' : locked ? '停台后可配置' : !profile ? '点击查看本机音色' : profile.ready ? '已保存参考音频与逐字稿' : profile.hasReference ? '还需保存逐字稿' : '尚未配置 · 可静音开台';
  const close = () => { if (!busy) { setOpened(false); setConfirmClear(false); } };
  return <div className="live-workbench-config-item">
    <button type="button" className="live-workbench-config-row" aria-label={`${name}专属音色`} aria-haspopup="dialog" aria-expanded={opened} disabled={!target||!bridge||locked||busy} onClick={() => {setOpened(true);void perform('read');}}>
      <span className="live-workbench-config-icon"><PetNookIcon name="audio" /></span><span><strong>专属音色</strong><small>{summary}</small></span><span className="live-workbench-state" data-ready={profile?.ready || undefined}>{!target ? '待绑定' : !bridge ? '不可用' : profile?.ready ? '已配置' : profile ? '待配置' : '未读取'}</span><PetNookIcon name="chevron" />
    </button>
    {opened && <LiveSettingsDrawer title={`${name}的专属音色`} subtitle={`${instanceName} · 仅当前绑定实例`} busy={busy} onClose={close} footer={<><button type="button" className="interaction-button quiet" disabled={locked||busy} onClick={() => void perform('read')}><PetNookIcon name="refresh" />重新读取音色</button><button type="button" className="interaction-button primary" disabled={disabled||!valid||!profile?.hasReference||transcript===profile.referenceTranscript} onClick={() => void perform('saveTranscript')}>保存逐字稿</button></>}>
      <div className="live-settings-context"><PetNookIcon name="audio" /><div><strong>{instanceName}</strong><p>只用于直播，不影响桌面语音。</p></div></div>
      {locked && <p className="live-settings-notice">请停台并恢复桌宠联动后再编辑。</p>}
      <p className="live-settings-read-state" role="status">{busy?'正在处理音色…':notice||(!profile?'请读取设置。':profile.ready?'音色资料已就绪，将在下次开台时准备声轨。':profile.hasReference?'已选择参考音频，还需保存逐字稿。':'尚未选择参考音频。')}</p>
      <section className="live-settings-section"><h3>参考音频</h3><p>选择一段清晰的 PCM WAV，让她拥有自己的声音。</p><div className="live-settings-audio"><PetNookIcon name="audio" /><div><strong>{profile?.hasReference ? '已保存专属参考音频' : '还没有参考音频'}</strong><small>PCM WAV · 仅保存在本机</small></div><span>WAV</span></div>
        <div className="live-settings-audio-actions"><button type="button" className="interaction-button secondary" disabled={disabled} onClick={() => void perform('selectReference')}>{profile?.hasReference?'更换参考 WAV':'选择参考 WAV'}</button><button type="button" className="interaction-button quiet live-settings-danger" disabled={disabled||!profile?.hasReference} onClick={() => setConfirmClear(true)}>移除参考</button></div>
        {confirmClear && <div className="live-settings-confirm" role="group" aria-label="确认移除直播音色"><p>仅移除应用保存的当前实例音色和逐字稿，不修改原始 WAV。</p><div className="button-row"><button type="button" className="interaction-button secondary" disabled={busy} onClick={() => setConfirmClear(false)}>取消</button><button type="button" className="interaction-button primary" disabled={disabled} onClick={() => void perform('clearReference')}>确认移除</button></div></div>}
      </section>
      {profile?.hasReference && <section className="live-settings-section"><label className="live-settings-label"><span>参考音频逐字稿</span><textarea rows={5} maxLength={4096} value={transcript} disabled={disabled} onChange={event => setTranscript(event.currentTarget.value)} /></label><p>与录音内容保持一致，有助于稳定本机合成表现。</p></section>}
      <details className="live-settings-help"><summary><PetNookIcon name="lock" />音色如何保存与使用？</summary><p>独立于「语音互动」。参考音频副本与逐字稿只保存到当前实例；不会自动发声。未配置时仍可静音开台，但不能发送弹幕演练。</p></details>
    </LiveSettingsDrawer>}
  </div>;
}
