import { isCharacterLearningCancelResult, isCharacterLearningInput, isCharacterLearningPreviewResult, isCharacterLearningGenerateResult, type CharacterLearningBridge, type CharacterLearningCancelResult, type CharacterLearningInput, type CharacterLearningPreview, type CharacterLearningErrorCode } from '../../../packages/contracts/src/character-learning.ts';
import type { LiveRoleId } from '../../../packages/contracts/src/live-stage.ts';
export type LiveLearningState = {phase:'idle'|'loading'|'preview'|'generating'|'review'|'failed';preview?:CharacterLearningPreview;candidateID?:string;error?:CharacterLearningErrorCode};
export async function cancelLearningSelection(bridge: Pick<CharacterLearningBridge, 'cancel'>, input: CharacterLearningInput, generating = false): Promise<CharacterLearningCancelResult> {
  try {
    const result = await bridge.cancel(input);
    if (isCharacterLearningCancelResult(result) && (result.ok || !generating)) return result;
  } catch { /* A lost acknowledgement does not prove the candidate was not written. */ }
  return { ok: false, error: generating ? 'write-outcome-unknown' : 'unavailable' };
}
export class LiveLearningSession {
  state:LiveLearningState={phase:'idle'};
  private retired=false;
  constructor(private readonly bridge:Pick<CharacterLearningBridge,'preview'|'generate'|'cancel'>,private readonly role:LiveRoleId,private readonly input:CharacterLearningInput,private readonly changed:(state:LiveLearningState)=>void=()=>{}) {}
  private publish(state:LiveLearningState){this.state=state;if(!this.retired)this.changed(state);}
  async select(){
    if(this.retired||this.state.phase!=='idle'||!isCharacterLearningInput(this.input))return;
    this.publish({phase:'loading'});
    try{
      const result=await this.bridge.preview(this.input);if(this.retired)return;
      if(!isCharacterLearningPreviewResult(result)||result.ok&&(result.preview.petID!==this.input.petID||result.preview.ticket!==this.input.ticket||result.preview.role!==this.role||result.preview.expiresAt<=Date.now()))return this.publish({phase:'failed',error:'unavailable'});
      this.publish(result.ok?{phase:'preview',preview:result.preview}:{phase:'failed',error:result.error});
    }catch{if(!this.retired)this.publish({phase:'failed',error:'unavailable'});}
  }
  async confirm(){
    const selected=this.state.preview;
    if(this.retired||this.state.phase!=='preview'||!selected)return;
    if(selected.expiresAt<=Date.now())return this.publish({phase:'failed',error:'expired'});
    this.publish({phase:'generating'});
    try{
      const result=await this.bridge.generate({...this.input,confirmation:selected.confirmation,expectedRevision:selected.revision,confirmed:true});
      if(this.retired)return;
      if(!isCharacterLearningGenerateResult(result)||result.ok&&(result.petID!==this.input.petID||result.revision<=selected.revision))return this.publish({phase:'failed',error:'write-outcome-unknown'});
      this.publish(result.ok?{phase:'review',candidateID:result.candidateID}:{phase:'failed',error:result.error});
    }catch{if(!this.retired)this.publish({phase:'failed',error:'write-outcome-unknown'});}
  }
  dispose(){
    if(this.retired)return;
    const generating=this.state.phase==='generating';
    this.retired=true;this.state={phase:'idle'};
    return cancelLearningSelection(this.bridge,this.input,generating);
  }
}
