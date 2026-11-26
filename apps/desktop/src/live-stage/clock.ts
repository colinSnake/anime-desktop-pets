import { isLiveDanmakuReply, liveActionLifetimeMs, liveVoiceStartBudgetMs, type LiveAction, type LiveProfile, type LiveScene, type LiveSnapshot } from '../../../../packages/contracts/src/live-stage.ts';
import { stageVoiceDuration, type LiveVoiceBank } from '../../../../packages/contracts/src/live-voice.ts';

export class LiveStageClock {
  private generation = 0;
  private playing?: { action: LiveAction; until: number; voiced: boolean; reply?: { text:string; audio:Buffer } };
  private voice?: LiveVoiceBank;
  private readonly profile: LiveProfile;
  constructor(profile: LiveProfile, private now = () => performance.now()) { this.profile = structuredClone(profile); }
  selectScene(scene: LiveScene) { this.profile.selected = scene; }
  setVoice(clips?: LiveVoiceBank) {
    this.voice = clips;
    this.stopDanmaku();
    if (this.playing) this.playing.voiced = false;
  }
  voiceFor(generation: number): Buffer | undefined {
    const next = this.snapshot();
    return next.voice && next.generation === generation && next.action ? (this.playing?.reply?.audio ?? this.voice?.[next.action]) : undefined;
  }
  trigger(action: LiveAction): true {
    this.generation++;
    const duration = this.voice && stageVoiceDuration(this.voice[action]);
    this.playing = { action, voiced: !!duration, until: this.now() + Math.max(liveActionLifetimeMs, duration ? duration + liveVoiceStartBudgetMs : 0) };
    return true;
  }
  hasManualCue(): boolean {
    const cue = this.snapshot();
    return cue.action !== undefined && cue.reply === undefined;
  }
  publishDanmaku(text: string, audio: Buffer): boolean {
    const duration = stageVoiceDuration(audio);
    if (!this.voice || !isLiveDanmakuReply(text) || !duration || this.hasManualCue()) return false;
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
    return { protocol: 1, scene, placement: { ...scenes[scene] }, generation: this.generation,
      ...(active && remainingMs > 0 && { action: active.action, remainingMs, ...(active.voiced && {voice:true as const}), ...(active.reply && {reply:active.reply.text}) }) };
  }
}
