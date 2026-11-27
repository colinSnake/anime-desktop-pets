import type { LiveVoiceProfileMutation } from '../../../../packages/contracts/src/live-voice-profile.ts';
import type { CharacterLearningCancelResult, CharacterLearningInput } from '../../../../packages/contracts/src/character-learning.ts';
import type { LiveVoiceResult } from '../../../../packages/contracts/src/live-voice.ts';
import { isLiveDanmaku, isLiveScene, isLiveRoleId, isLiveRoleAction, type LiveRoleId, type LiveDanmakuError, type LiveDanmakuState, type LiveScene, type LiveRoleAction, type LiveMethod, type LiveProfile, type LiveProfileResult, type LiveResult, type LiveVoiceState, type LiveLearningHandle } from '../../../../packages/contracts/src/live-stage.ts';
import { LiveStageClock } from './clock.ts';
import type { StageOutput } from './output.ts';
const unavailable = {ok:false,error:'unavailable'} as const;
const busy = {ok:false,error:'busy'} as const;

type ActiveStage = { role:LiveRoleId; output: StageOutput; clock: LiveStageClock; profile: LiveProfile; voice?: LiveVoiceState; voiceScope?:LiveVoiceProfileMutation; voiceJob?: AbortController; danmaku?: LiveDanmakuState };

export class LiveStageController {
  private active?: ActiveStage;
  private danmakuJob?: { controller:AbortController; task:Promise<void> };
  private changing?: Promise<LiveResult>;
  private changingRole?: LiveRoleId;
  private version = 0;
  private stopping?: Promise<void>;
  private retired = false;
  constructor(private readonly deps: {
    profile(input: LiveProfile | undefined,role:LiveRoleId): Promise<LiveProfileResult>;
    allowed(): Promise<boolean>;
    open(role:LiveRoleId,clock: LiveStageClock, current: () => boolean): Promise<StageOutput>;
    preview(url: string, role:LiveRoleId): Promise<void>;
    closePreview(): void;
    copy(url: string): void;
    voice?(signal: AbortSignal, role: LiveRoleId): Promise<LiveVoiceResult & {scope?:LiveVoiceProfileMutation}>;
    danmaku?(role:LiveRoleId,text:string, scene:LiveScene, signal:AbortSignal, synthesizing:() => void,voice?:LiveVoiceProfileMutation): Promise<
      {ok:true; text:string; audio:Buffer; learning?:LiveLearningHandle} | {ok:false; error:LiveDanmakuError}>;
    cancelLearning?(input:CharacterLearningInput): Promise<CharacterLearningCancelResult>;
  }) {}

  get canConfigureVoice() { return !this.retired && !this.active && !this.changing && !this.stopping; }

  ownsLearning(input: CharacterLearningInput) {
    const state = this.active?.danmaku;
    return state?.phase === 'published' && !!state.learning && state.learning.expiresAt > Date.now() &&
      state.learning.petID === input.petID && state.learning.ticket === input.ticket;
  }
  cancelLearning(input: CharacterLearningInput) {
    const active = this.active;
    if (active && this.ownsLearning(input)) active.danmaku = {phase:'published'};
    return this.deps.cancelLearning?.(input);
  }
  private revokeLearning(learning?: LiveLearningHandle) {
    if (learning) void this.cancelLearning({petID:learning.petID,ticket:learning.ticket})?.catch(()=>{});
  }

  cancelDanmaku() {
    const active = this.active;
    if (!active?.danmaku) return;
    if (active.danmaku.phase === 'published') this.revokeLearning(active.danmaku.learning);
    active.clock.stopDanmaku();
    this.danmakuJob?.controller.abort();
    active.danmaku = {phase:'stopped'};
  }

  private prepareVoice(active: ActiveStage) {
    const prepare = this.deps.voice;
    if (!prepare) return;
    const job = new AbortController();
    active.voiceJob = job;
    active.voice = 'preparing';
    const owned = () => !job.signal.aborted && this.active === active;
    void (async () => {
      try {
        const result = await prepare(job.signal,active.role);
        if (!owned()) return;
        if (result.ok) { active.clock.setVoice(result.clips,active.role); active.voice = 'ready'; active.voiceScope=result.scope; }
        else active.voice = result.error;
      } catch {
        if (owned()) active.voice = 'voice-failed';
      } finally { active.voiceJob = undefined; }
    })();
  }

  /** Invalidates a start before awaiting any I/O; no late listen can republish it. */
  stop(): Promise<void> {
    this.cancelDanmaku();
    this.version++;
    const active = this.active;
    this.active = undefined;
    active?.clock.setVoice();
    active?.voiceJob?.abort();
    this.deps.closePreview();
    if (active && !this.stopping) {
      const operation = active.output.close().finally(() => { if (this.stopping === operation) this.stopping = undefined; });
      this.stopping = operation;
    }
    return this.stopping ?? Promise.resolve();
  }
  async close() {
    this.retired = true;
    const outcomes = await Promise.allSettled([this.stop(), this.changing, this.danmakuJob?.task]);
    const failure = outcomes.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
  async run(method: LiveMethod, input: unknown, eligible: () => boolean, selectedRole:unknown='longmei'): Promise<LiveResult> {
    if (!eligible() || this.retired || !isLiveRoleId(selectedRole)) return unavailable;
    const role=selectedRole;
    const version = this.version;
    const current = () => eligible() && version === this.version && !this.retired;
    const view = (profile: LiveProfile, running = false): LiveResult => ({ok:true,profile:structuredClone(profile),running, ...(running && this.active && {activeRole:this.active.role}), ...(this.deps.voice && {voice: (running && this.active?.voice) || 'muted'}), ...(running && this.active?.danmaku && {danmaku:this.active.danmaku})});
    if (method === 'stop') {
      if ((this.active && this.active.role !== role) || (this.changing && this.changingRole !== role)) return unavailable;
      const profile = this.active?.profile;
      const pending = profile ? this.changing : undefined;
      await this.stop();
      // An authorized write may already have reached storage before the listener closed.
      if (pending) await Promise.allSettled([pending]);
      if (!eligible() || this.retired) return unavailable;
      if (profile && !pending) return view(profile);
      const result = await this.deps.profile(undefined,role);
      return !eligible() || this.retired ? unavailable : this.active ? view(this.active.profile,true) : result.ok ? view(result.profile) : result;
    }
    const active = this.active;
    if (method === 'read') {
      if (active) return view(active.profile,true);
      const result = await this.deps.profile(undefined,role);
      return !current() ? unavailable : this.active ? view(this.active.profile,true) : result.ok ? view(result.profile) : result;
    }
    if (method === 'submitDanmaku' || method === 'stopDanmaku') {
      if (!active || active.role!==role || !this.deps.danmaku) return unavailable;
      if (method === 'stopDanmaku') {
        this.cancelDanmaku();
        return view(active.profile,true);
      }
      if (active.voice !== 'ready' || !isLiveDanmaku(input)) return unavailable;
      if (this.danmakuJob || active.clock.hasManualCue()) return busy;
      const abort = new AbortController();
      const scene = active.profile.selected;
      const owned = () => this.active === active && !abort.signal.aborted;
      if (active.danmaku?.phase === 'published') this.revokeLearning(active.danmaku.learning);
      active.clock.stopDanmaku();
      active.danmaku = {phase:'generating'};
      const task = Promise.resolve().then(async () => {
        if (!owned()) return;
        try {
          const result = await this.deps.danmaku!(role,input, scene, abort.signal, () => {
            if (owned()) active.danmaku = {phase:'synthesizing'};
          },active.voiceScope);
          if (!owned() || !current()) {
            if (result.ok) this.revokeLearning(result.learning);
            if (owned()) this.cancelDanmaku();
            return;
          }
          if (!result.ok) active.danmaku = {phase:'failed',error:result.error};
          else if (active.clock.publishDanmaku(result.text,result.audio)) {
            active.danmaku = {phase:'published',...(result.learning && {learning:result.learning})};
          } else {
            this.revokeLearning(result.learning);
            active.danmaku = {phase:'failed',error:'speech-failed'};
          }
        } catch {
          if (owned()) active.danmaku = {phase:'failed',error:active.danmaku?.phase === 'synthesizing' ? 'speech-failed' : 'model-failed'};
        }
      }).finally(() => { if (this.danmakuJob?.controller === abort) this.danmakuJob = undefined; });
      this.danmakuJob = {controller:abort,task};
      return view(active.profile,true);
    }
    if (method === 'switchScene') {
      if (!active || active.role!==role || !isLiveScene(input)) return unavailable;
      if (this.changing || this.stopping) return busy;
      if (input === active.profile.selected) return view(active.profile, true);
      const operation = (async (): Promise<LiveResult> => {
        if (!await this.deps.allowed()) return current() ? busy : unavailable;
        if (!current()) return unavailable;
        const result = await this.deps.profile({ ...active.profile, selected: input },role);
        if (this.active !== active || version !== this.version || this.retired) return unavailable;
        if (!result.ok) return result;
        if (result.profile.selected !== input) return unavailable;
        // Once accepted, keep storage and the program in sync even if the workspace hides.
        active.profile = { ...active.profile, selected: input };
        active.clock.selectScene(input);
        return current() ? view(active.profile, true) : unavailable;
      })();
      this.changing = operation; this.changingRole = role;
      try { return await operation; } finally { this.changing = undefined; this.changingRole = undefined; }
    }
    if (method !== 'save' && method !== 'start') {
      if (!active || active.role!==role) return unavailable;
      if (method === 'trigger') { if(!isLiveRoleAction(role,input))return unavailable;this.cancelDanmaku();active.clock.trigger(input as LiveRoleAction); }
      if (method === 'copy') this.deps.copy(active.output.url);
      if (method === 'preview') {
        try { await this.deps.preview(active.output.url,active.role); } catch { return unavailable; }
      }
      return current() ? view(active.profile,true) : unavailable;
    }
    if (active || this.changing || this.stopping) return busy;
    const operation = (async (): Promise<LiveResult> => {
      if (!await this.deps.allowed()) {
        const state = await this.deps.profile(undefined,role);
        return state.ok ? busy : state;
      }
      if (!current()) return unavailable;
      const result = await this.deps.profile(method === 'save' ? input as LiveProfile : undefined,role);
      if (!result.ok) return result;
      if (!current()) return unavailable;
      if (method === 'save') return view(result.profile);
      const clock = new LiveStageClock(result.profile,role);
      let output: StageOutput;
      try { output = await this.deps.open(role,clock, current); } catch { return current() ? {ok:false,error:'media'} : unavailable; }
      if (!current()) { await output.close(); return unavailable; }
      const active = {role,output,clock,profile:result.profile};
      this.active = active;
      this.prepareVoice(active);
      return view(result.profile,true);
    })();
    this.changing = operation; this.changingRole = role;
    try { return await operation; } finally { this.changing = undefined; this.changingRole = undefined; }
  }
}
