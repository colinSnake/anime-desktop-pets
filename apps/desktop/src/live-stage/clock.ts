import { isLiveDanmakuReply, isLiveRoleAction, liveActionLifetimeMs, liveVoiceStartBudgetMs, type LiveAction, type LiveProfile, type LiveRoleAction, type LiveRoleId, type LiveScene, type LiveSnapshot } from '../../../../packages/contracts/src/live-stage.ts';
import { stageVoiceDuration, type LiveVoiceBank } from '../../../../packages/contracts/src/live-voice.ts';

export class LiveStageClock {
  private generation = 0;
  private playing?: { action: LiveRoleAction; until: number; voiced: boolean; reply?: { text:string; audio:Buffer } };
  private voice?: LiveVoiceBank;
  private readonly profile: LiveProfile;
  private readonly role: LiveRoleId;
  private readonly now: () => number;
  constructor(profile: LiveProfile, now?: () => number);
  constructor(profile: LiveProfile, role: LiveRoleId, now?: () => number);
  constructor(profile: LiveProfile, roleOrNow: LiveRoleId | (() => number) = 'longmei', now = () => performance.now()) {
    this.profile = structuredClone(profile);
    this.role = typeof roleOrNow === 'string' ? roleOrNow : 'longmei';
    this.now = typeof roleOrNow === 'function' ? roleOrNow : now;
  }
  selectScene(scene: LiveScene) { this.profile.selected = scene; }
  setVoice(clips?: LiveVoiceBank) {
    this.voice = this.role==='longmei'?clips:undefined;
    this.stopDanmaku();
    if (this.playing) this.playing.voiced = false;
  }
  voiceFor(generation: number): Buffer | undefined {
    const next = this.snapshot();
    return next.voice && this.role==='longmei' && next.generation === generation && next.action ? (this.playing?.reply?.audio ?? this.voice?.[next.action as LiveAction]) : undefined;
  }
  trigger(action: LiveRoleAction): true {
    if(!isLiveRoleAction(this.role,action))throw new Error('invalid_live_action');
    this.generation++;
    const duration = this.role==='longmei'&&this.voice&&isDragonAction(action)?stageVoiceDuration(this.voice[action]):undefined;
    this.playing = { action, voiced: !!duration, until: this.now() + Math.max(liveActionLifetimeMs, duration ? duration + liveVoiceStartBudgetMs : 0) };
    return true;
  }
  hasManualCue(): boolean {
    const cue = this.snapshot();
    return cue.action !== undefined && cue.reply === undefined;
  }
  publishDanmaku(text: string, audio: Buffer): boolean {
    const duration = stageVoiceDuration(audio);
    if (this.role!=='longmei'||!this.voice || !isLiveDanmakuReply(text) || !duration || this.hasManualCue()) return false;
    this.generation++;
    this.playing = { action:'01', voiced:true, reply:{text,audio}, until:this.now() + Math.max(liveActionLifetimeMs, duration + liveVoiceStartBudgetMs) };
    return true;
  }
  stopDanmaku() { if (this.playing?.reply) this.playing = undefined; }
  snapshot(): LiveSnapshot {
    const { selected: scene, scenes } = this.profile;
    const active = this.playing;
    const remainingMs = active ? Math.ceil(active.until - this.now()) : 0;
    if (!remainingMs || remainingMs < 0) this.playing = undefined;
    return { protocol: 1, role:this.role, scene, placement: { ...scenes[scene] }, generation: this.generation,
      ...(active && remainingMs > 0 && { action: active.action, remainingMs, ...(active.voiced && {voice:true as const}), ...(active.reply && {reply:active.reply.text}) }) };
  }
}
function isDragonAction(action:LiveRoleAction):action is LiveAction{return action==='01'||action==='18'||action==='20';}
