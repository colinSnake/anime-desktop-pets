import type { PreviewQuotaResult } from './quota-result';
import type { Clip } from './playback';
import type { Point } from './motion';
import type { CaptionState } from './captions';
import type { Facing } from './locomotion';

export type Gesture = 'begin' | 'move' | 'release' | 'cancel';
export type FrameEvent = 'shown' | 'ended' | 'failed';
export type PreviewQuotaState = { kind: 'loading' } | { kind: 'closed' } | (PreviewQuotaResult & { queriedAt: number });
export interface PreviewBridge {
  onAction(onClip: (clip: Clip, generation: number) => void): void;
  onFace(update: (generation: number, facing: Facing) => void): void;
  onDragReset(reset: () => void): void;
  onMenuState(update: (open: boolean, cursor?: Point) => void): void;
  openMenu(): void;
  onCaption(update: (state?: CaptionState) => void): void;
  captionShown(token: number): void;
  onQuota(update: (state: PreviewQuotaState) => void): void;
  requestQuota(): void;
  refreshQuota(): void;
  closeQuota(): void;
  hit(opaque: boolean): void;
  reducedMotion(reduced: boolean): void;
  gesture(phase: Gesture): void;
  travelFrame(generation: number, mediaMs: number): void;
  frame(event: FrameEvent, clip: Clip, generation: number): void;
}
