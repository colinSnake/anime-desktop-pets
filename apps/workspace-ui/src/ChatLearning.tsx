import { useEffect, useRef, useState } from 'react';
import { isCharacterLearningPreviewResult, isCharacterLearningGenerateResult, type CharacterLearningBridge, type CharacterLearningChatSelection, type CharacterLearningInput, type CharacterLearningPreview } from '../../../packages/contracts/src/character-learning.ts';
import type { DesktopBridge } from '../../../packages/contracts/src/index.ts';
import { cancelLearningSelection } from './live-learning-state.ts';
import { LiveLearningReview } from './pages/LiveLearningReview.tsx';

type State = {phase:'loading'|'preview'|'generating'|'cancelling'|'review'|'failed';preview?:CharacterLearningPreview;candidateID?:string;error?:string};
const unknown = '未能确认候选是否保存。请到「桌宠 Agent → 记忆」核对，不会自动重试。';
export function ChatLearning({bridge,selection,characters,locked,onClose}:{bridge:CharacterLearningBridge;selection:CharacterLearningChatSelection;characters?:DesktopBridge['characters'];locked:boolean;onClose():void}){
  const [state,setState]=useState<State>({phase:'loading'});
  const work=useRef<{retired:boolean;claimed:boolean;generating?:boolean;input?:CharacterLearningInput;timer?:ReturnType<typeof setTimeout>}|undefined>(undefined);
  useEffect(()=>{
    const own:NonNullable<typeof work.current>={retired:false,claimed:false};work.current=own;
    const cancel=(input:CharacterLearningInput)=>{void bridge.cancel(input).catch(()=>{});};
    void bridge.selectChatTurn(selection).then(result=>{
      if(!isCharacterLearningPreviewResult(result)||!result.ok || result.preview.source!=='chat'||result.preview.petID!==selection.petID){
        if(!own.retired)setState({phase:'failed',error:'只可选择当前角色已保存、无附件和角色资料的普通文字回合。'});return;
      }
      const {petID,ticket,expiresAt}=result.preview;const input={petID,ticket};
      if(own.retired){cancel(input);return;}
      if(expiresAt<=Date.now()){cancel(input);setState({phase:'failed',error:'所选回合已过期，请再次选择。'});return;}
      own.input=input;
      own.timer=setTimeout(()=>{if(own.input){cancel(own.input);own.input=undefined;own.claimed=true;setState({phase:'failed',error:own.generating?unknown:'所选回合已过期，请再次选择。'});}},Math.max(0,expiresAt-Date.now()));
      setState({phase:'preview',preview:result.preview});
    }).catch(()=>{if(!own.retired)setState({phase:'failed',error:'未能读取所选回合。'});});
    return()=>{own.retired=true;clearTimeout(own.timer);if(own.input)cancel(own.input);if(work.current===own)work.current=undefined;};
  },[bridge,selection]);
  async function confirm(){
    const own=work.current,preview=state.preview;
    if(locked||!own?.input||own.claimed||state.phase!=='preview'||!preview||preview.expiresAt<=Date.now())return;
    own.claimed=true;own.generating=true;
    setState({phase:'generating'});
    try{
      const result=await bridge.generate({...own.input,confirmation:preview.confirmation,expectedRevision:preview.revision,confirmed:true});
      if(own.retired||!own.input)return;
      clearTimeout(own.timer);
      if(!isCharacterLearningGenerateResult(result)||result.ok&&(result.petID!==selection.petID||result.revision<=preview.revision))setState({phase:'failed',error:unknown});
      else if(result.ok)setState({phase:'review',candidateID:result.candidateID});
      else setState({phase:'failed',error:result.error==='unavailable'||result.error==='write-outcome-unknown'?unknown:'未保存新的偏好候选。'});
    }catch{if(!own.retired&&own.input)setState({phase:'failed',error:unknown});}
    finally{clearTimeout(own.timer);if(own.input){void bridge.cancel(own.input).catch(()=>{});own.input=undefined;}}
  }
  async function dismiss(){
    const own=work.current;
    if(state.phase==='cancelling')return;
    if(!own?.input||!own.generating){onClose();return;}
    const input=own.input;own.input=undefined;own.retired=true;clearTimeout(own.timer);
    setState({phase:'cancelling'});
    const result=await cancelLearningSelection(bridge,input,true);
    if(work.current!==own||document.hidden)return;
    if(result.ok)onClose();else setState({phase:'failed',error:unknown});
  }
  return <section className="chat-learning" aria-label="单轮偏好学习" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();void dismiss();}}}>
    {state.phase==='loading'&&<p role="status">正在读取所选一轮…</p>}
    {state.phase==='preview'&&state.preview&&<><p>确认后只发送下列一轮给已保存的默认模型（可能计费），最多生成一条待人工审核的表达偏好。</p>
      <p><strong>你的消息：</strong>{state.preview.user}</p><p><strong>回复：</strong>{state.preview.assistant}</p>
      <button type="button" className="button primary" disabled={locked} onClick={()=>void confirm()}>确认生成候选</button>
    </>}
    {state.phase==='cancelling'&&<p role="status">正在取消学习…</p>}
    {state.phase==='generating'&&<p role="status">正在生成偏好候选…</p>}
    {state.phase==='failed'&&<p role="status">{state.error}</p>}
    {state.phase==='review'&&state.candidateID&&<LiveLearningReview petID={selection.petID} recordID={state.candidateID} characters={characters} locked={locked} />}
    <button type="button" className="chat-control" autoFocus disabled={state.phase==='cancelling'} onClick={()=>void dismiss()}>{state.phase==='review'||state.phase==='failed'?'关闭':'取消学习'}</button>
  </section>;
}
