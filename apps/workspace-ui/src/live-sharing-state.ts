import { isLiveSharingResult, liveSharingLimit, type LiveSharingInput, type LiveSharingResult, type LiveSharingRow, type LiveSharingSnapshot, type LiveShareRecord } from '../../../packages/contracts/src/live-sharing.ts';
import type { LiveRoleId } from '../../../packages/contracts/src/live-stage.ts';
export type LiveSharingPort={readShares(role:LiveRoleId):Promise<LiveSharingResult>;writeShares(input:LiveSharingInput):Promise<LiveSharingResult>};
export type LiveSharingState={phase:'loading'|'ready'|'saving'|'needs-read';snapshot?:LiveSharingSnapshot};
const same=(a:LiveShareRecord,b:LiveShareRecord)=>a.kind===b.kind&&a.recordID===b.recordID&&a.recordRevision===b.recordRevision;
const recordOf=({kind,recordID,recordRevision}:LiveShareRecord):LiveShareRecord=>({kind,recordID,recordRevision});
export class LiveSharingSession {
  state:LiveSharingState={phase:'loading'};
  private closed=false;
  private busy=false;
  constructor(private readonly bridge:LiveSharingPort,private readonly role:LiveRoleId,private readonly petID:string,private readonly notify: (state:LiveSharingState)=>void=()=>{}){}
  private publish(state:LiveSharingState){if(!this.closed){this.state=state;this.notify(state);}}
  private accepts(result:unknown):result is Extract<LiveSharingResult,{ok:true}>{return isLiveSharingResult(result)&&result.ok&&result.snapshot.role===this.role&&result.snapshot.petID===this.petID;}
  dispose(){this.closed=true;this.state={phase:'loading'};}
  async load(){
    if(this.closed||this.busy)return;this.busy=true;this.publish({phase:'loading'});
    try{const result=await this.bridge.readShares(this.role);this.publish(this.accepts(result)?{phase:'ready',snapshot:result.snapshot}:{phase:'needs-read'});}
    catch{this.publish({phase:'needs-read'});}finally{this.busy=false;}
  }
  async set(row:LiveSharingRow,enabled:boolean){
    const {snapshot}=this.state;
    if(this.closed||this.busy||this.state.phase!=='ready'||!snapshot)return;
    const current=snapshot.records.find(r=>same(r,row));if(!current||current.enabled===enabled)return;
    const records=snapshot.records.filter(r=>same(r,row)?enabled:r.enabled).map(recordOf);
    if(records.length>liveSharingLimit)return;
    const input:LiveSharingInput={role:this.role,petID:this.petID,bindingRevision:snapshot.bindingRevision,expectedRevision:snapshot.revision,records};
    this.busy=true;this.publish({phase:'saving',snapshot});
    try{
      const result=await this.bridge.writeShares(input);
      if(this.accepts(result)&&result.snapshot.bindingRevision===input.bindingRevision&&result.snapshot.revision===input.expectedRevision+1){
        const granted=result.snapshot.records.filter(r=>r.enabled);
        if(granted.length===records.length&&records.every(r=>granted.some(g=>same(r,g)))){this.publish({phase:'ready',snapshot:result.snapshot});return;}
      }
      this.publish({phase:'needs-read'});
    }catch{this.publish({phase:'needs-read'});}finally{this.busy=false;}
  }
}
