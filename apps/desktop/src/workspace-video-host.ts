import { videoCommand, videoCue, videoMenu, videoPosition, type VideoMenuIntent, type VideoCaptionSpeech, type VideoCommand, type VideoDisplay, type VideoMessage, type VideoPosition, type VideoReply, type VideoResult } from '../../app-service/src/workspace-video-protocol.ts';

import type { BehaviorPreferences } from '../../../packages/contracts/src/pets.ts';
import type { TaskAnimation } from '../../app-service/src/task-animation.ts';

export type OwnedVideoWindow = { ready: Promise<boolean>; stop(): boolean; applyDisplay?(value: VideoDisplay): boolean; applyBehavior?(value: BehaviorPreferences): boolean; setVisible?(value: boolean): boolean; applyTaskAnimation?(value: TaskAnimation): boolean; applyCaptionSpeech?(value: VideoCaptionSpeech): void };
type Start = Extract<VideoCommand, { op: 'start' }>;
type End = 'stopped' | 'failed';
type Own = { slot: number; epoch: number; window?: OwnedVideoWindow; opening: boolean; stopping: boolean; dispatched: boolean; timer?: ReturnType<typeof setTimeout> };

/** No renderer can supply one of these commands or act as the service transport. */
export class WorkspaceVideoHost {
  private readonly own = new Map<string, Own>();
  private active = true;
  private lastSeq = 0;
  constructor(private readonly open: (input: Start, ended: (result: End) => void, slot: number, drop: (position: VideoPosition) => void, cue: (text: string | undefined, token: number) => void, menu: (intent: VideoMenuIntent) => void) => OwnedVideoWindow,
    private readonly startTimeout = 5500, readonly drain: () => Promise<void> = async () => {}) {}

  receive(input: unknown, send: (reply: VideoMessage) => void, allowStart = true) {
    if (!videoCommand(input)) return false;
    if (input.seq <= this.lastSeq) return true;
    this.lastSeq = input.seq;
    const publish = (message: VideoMessage) => { try { send(message); } catch { this.close(); } };
    const reply = (result: VideoResult, type: VideoReply['type'] = 'workspace-video-result') => {
      publish({ type, version: 1, seq: input.seq, id: input.id, result });
    };
    const current = this.own.get(input.id);
    if (input.op === 'stop') {
      reply(!current || this.stop(input.id, current) ? 'stopped' : 'failed');
      return true;
    }
    if (input.op === 'task' || input.op === 'caption-speech') {
      if (this.active && allowStart && current?.dispatched && !current.stopping && current.epoch === input.epoch) {
        try {
          if (input.op === 'task') current.window?.applyTaskAnimation?.(input.value);
          else current.window?.applyCaptionSpeech?.(input.value);
        } catch { /* The prior lease expires independently. */ }
      }
      return true;
    }
    if (input.op !== 'start') {
      if (!this.active || !allowStart || !current?.dispatched || current.stopping || current.epoch !== input.epoch) {
        reply('failed'); return true;
      }
      let confirmed = false;
      try {
        confirmed = (input.op === 'display' ? current.window?.applyDisplay?.(input.value)
          : input.op === 'behavior' ? current.window?.applyBehavior?.(input.value)
          : current.window?.setVisible?.(input.value)) === true;
      } catch { /* No confirmation from the native window. */ }
      reply(confirmed && this.own.get(input.id) === current ? 'applied' : 'failed');
      return true;
    }
    if (!this.active || !allowStart || current || this.own.size >= 3) { reply('failed'); return true; }
    const taken = new Set([...this.own.values()].map(own => own.slot));
    const slot = [0, 1, 2].find(index => !taken.has(index))!;
    const owned: Own = { slot, epoch: input.seq, opening: true, stopping: false, dispatched: false };
    this.own.set(input.id, owned);
    const ended = (result: End) => {
      if (this.own.get(input.id) !== owned) return;
      clearTimeout(owned.timer);
      this.own.delete(input.id);
      if (!owned.stopping) reply(owned.dispatched ? result : 'failed', owned.dispatched ? 'workspace-video-ended' : undefined);
      else if (owned.opening) reply('failed');
      owned.opening = false;
    };
    const finish = (success: boolean) => {
      if (this.own.get(input.id) !== owned || !owned.opening) return;
      clearTimeout(owned.timer);
      owned.opening = false;
      if (success && !owned.stopping) {
        owned.dispatched = true;
        reply('running');
      } else {
        this.stop(input.id, owned);
        reply('failed');
      }
    };
    const drop = (position: VideoPosition) => {
      if (!this.active || this.own.get(input.id) !== owned || !owned.dispatched || owned.stopping || !videoPosition(position)) return;
      publish({ type: 'workspace-video-drop', version: 1, id: input.id, seq: input.seq, x: position.x, y: position.y });
    };
    const cue = (text: string | undefined, token: number) => {
      if (!this.active || this.own.get(input.id) !== owned || !owned.dispatched || owned.stopping) return;
      const event = { type: 'workspace-video-cue', version: 1, id: input.id, seq: input.seq, cue: token, text: text ?? null };
      if (videoCue(event)) publish(event);
    };
    const menu = (intent: VideoMenuIntent) => {
      if (!this.active || this.own.get(input.id) !== owned || !owned.dispatched || owned.stopping) return;
      const event = { type: 'workspace-video-menu', version: 1, id: input.id, seq: input.seq, intent };
      if (videoMenu(event)) publish(event);
    };
    try {
      owned.window = this.open(input, ended, owned.slot, drop, cue, menu);
      if (this.own.get(input.id) === owned) owned.timer = setTimeout(() => finish(false), this.startTimeout);
      void owned.window.ready.then(finish, () => finish(false));
    } catch { ended('failed'); }
    return true;
  }

  private stop(id: string, owned: Own) {
    owned.stopping = true;
    let stopped = false;
    try { stopped = owned.window?.stop() === true; } catch { /* not confirmed */ }
    if (stopped) {
      clearTimeout(owned.timer);
      this.own.delete(id);
    }
    return stopped;
  }

  close() {
    this.active = false;
    for (const [id, owned] of this.own) this.stop(id, owned);
    return this.own.size === 0;
  }
}
