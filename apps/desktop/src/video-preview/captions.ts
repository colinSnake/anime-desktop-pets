import { isCue } from '../../../app-service/src/speech/cue.ts';
import type { VideoSpeechState } from '../../../app-service/src/workspace-video-protocol.ts';
import { activityVariants } from './activity-schedule';

export const workCaptions = {
  work: '收到新任务啦，陪你一起认真开工！',
  work02: '小爪爪准备好了，陪你专心处理任务。',
  work03: '整理一下思路，陪你把线索摆整齐。',
  work04: '翻翻资料，陪你寻找下一步的灵感。',
  work05: '认真检查一下，陪你留意小细节。',
} as const;
export const interactionClips = [...activityVariants, 'work', 'work02', 'work03', 'work04', 'work05'] as const;
export type InteractionClip = typeof interactionClips[number];
export type VideoLines = Partial<Record<InteractionClip, string>>;
export function parseVideoLines(value: unknown): VideoLines | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const entries = Object.entries(value);
  if (entries.length > interactionClips.length || entries.some(([key, line]) =>
    !interactionClips.some(clip => clip === key) || !isCue(line))) return;
  return Object.fromEntries(entries);
}

export type CaptionState = { token: number; text: string };
type Kind = 'task' | 'interaction' | 'greeting';
// Fail-safe for a lost terminal event: one pending turn plus one worker run (180 s each), and cleanup.
const maxSpeechHold = 370_000;
const speechTail = 700;

/** Caption is a native window decision; renderer only acknowledges the token it painted. */
export class CaptionSchedule {
  private serial = 0;
  private active?: CaptionState & { kind: Kind; expiresAt: number; confirmed: boolean; speechUntil?: number; speechEnd?: 'drained' | 'released' };
  constructor(private readonly publish: (state: CaptionState | undefined) => void,
    private readonly offer: (text: string | undefined, token: number) => void) {}

  get kind() { return this.active?.kind; }
  get speechProtected() { return this.active?.speechUntil !== undefined || this.active?.speechEnd === 'drained'; }
  show(kind: Kind, text: string, now: number) {
    if (!isCue(text)) return;
    this.clear();
    const token = ++this.serial;
    const duration = Math.min(30_000, Math.max(4000, 1800 + [...text.replace(/\s/g, '')].length * 210));
    this.active = { token, text, kind, expiresAt: now + duration, confirmed: false };
    this.publish({ token, text });
    return token;
  }
  confirm(token: unknown, visible: boolean, now: number) {
    const active = this.active;
    if (!visible || !active || active.token !== token || active.confirmed || now >= active.expiresAt) return false;
    active.confirmed = true;
    this.offer(active.text, active.token);
    return true;
  }
  speech(token: number, state: VideoSpeechState, now: number) {
    const active = this.active;
    if (!active?.confirmed || active.token !== token || active.speechEnd) return false;
    if (state === 'held') {
      if (active.speechUntil !== undefined || now >= active.expiresAt) return false;
      active.speechUntil = now + maxSpeechHold;
    } else {
      if (active.speechUntil === undefined || now >= active.speechUntil) return false;
      active.speechUntil = undefined;
      active.speechEnd = state;
      if (state === 'drained') active.expiresAt = Math.max(active.expiresAt, now + speechTail);
    }
    return true;
  }
  expire(now: number) {
    if (!this.active || now < (this.active.speechUntil ?? this.active.expiresAt)) return false;
    this.clear();
    return true;
  }
  clear() {
    const prior = this.active;
    if (!prior) return;
    this.active = undefined;
    if (prior.confirmed) this.offer(undefined, prior.token);
    this.publish(undefined);
  }
}

const greetings = [
  '我是龙妹，今天也要元气满满哟！', '忙里偷个闲，记得喝口水呀～', '我在这里陪着你，慢慢来就好。',
  '今天也给自己一点小小的夸奖吧！', '累了就歇一会儿，龙妹帮你看着桌面～', '愿你的灵感像小星星一样闪闪发亮！',
  '嘿，看到你啦！一起把今天过得可爱一点～', '深呼吸一下，接下来也会顺顺利利的。',
] as const;
export class IdleGreetings {
  private nextAt: number;
  private previous?: typeof greetings[number];
  constructor(now: number, private readonly random = Math.random) { this.nextAt = now + 18_000 + 18_000 * random(); }
  due(now: number) { return now >= this.nextAt; }
  userActivity(now: number) { this.nextAt = Math.max(this.nextAt, now + 90_000); }
  next(now: number, allowed: boolean) {
    if (now < this.nextAt) return;
    this.nextAt = now + (allowed ? 150_000 + 90_000 * this.random() : 15_000 + 10_000 * this.random());
    if (!allowed) return;
    const pool = greetings.filter(line => line !== this.previous);
    return this.previous = pool[Math.floor(this.random() * pool.length)]!;
  }
}
