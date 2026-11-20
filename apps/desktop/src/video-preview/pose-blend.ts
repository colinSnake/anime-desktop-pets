import type { Clip } from './playback';
import type { PoseRect } from './pose-geometry';

const isDragPose = (clip: Clip) => clip === 'drag' || clip.startsWith('move') || clip.startsWith('release-');
export const loopBlendMs = 60;
export const bounceBlendMs = (clip: Clip, from: boolean, to: boolean, reduced: boolean, busy: boolean) =>
  clip.startsWith('release-') && from !== to && !reduced && !busy ? loopBlendMs : 0;
export const smoothMix = (t: number) => t * t * (3 - 2 * t);
export const dragBlendMs = (previous: Clip, next: Clip, reduced: boolean) =>
  reduced || (!isDragPose(previous) && !isDragPose(next)) ? 0 : next === 'idle' ? 280 : 160;

export function drawVideo(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, rect: PoseRect) {
  const { x, y, width, height = width, mirrored } = rect;
  if (!mirrored) { ctx.drawImage(video, x, y, width, height); return; }
  ctx.save();
  try { ctx.translate(x + width, y); ctx.scale(-1, 1); ctx.drawImage(video, 0, 0, width, height); }
  finally { ctx.restore(); }
}

type Painter = (ctx: CanvasRenderingContext2D, edge: number) => void;

/** Only allocates graphics for a handoff; continuous playback remains native video. */
export function createPoseBlend(front: HTMLCanvasElement) {
  let source: HTMLCanvasElement | undefined;
  let frame: number | undefined;
  let resume: (() => void) | undefined;
  const clear = () => {
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    frame = undefined;
    front.hidden = true;
    resume = undefined;
  };
  const finish = () => {
    const done = resume;
    clear();
    done?.();
  };
  return {
    freeze(paint: Painter): boolean {
      const wasShowing = !front.hidden;
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = undefined;
      resume = undefined;
      const size = Math.min(720, Math.max(1, Math.round(window.innerWidth * window.devicePixelRatio)));
      source ??= document.createElement('canvas');
      source.width = source.height = size;
      const old = source.getContext('2d');
      const ctx = front.getContext('2d');
      if (!old || !ctx) { clear(); return false; }
      try {
        if (wasShowing) old.drawImage(front, 0, 0, size, size);
        else paint(old, size);
        front.width = front.height = size;
        ctx.drawImage(source, 0, 0);
        front.hidden = false;
        return true;
      } catch { clear(); return false; }
    },
    blend(duration: number, paint: Painter, done: () => void) {
      const ctx = front.getContext('2d');
      const frozen = source;
      if (front.hidden || !duration || !ctx || !frozen) { clear(); done(); return; }
      let elapsed = 0;
      let last: number | undefined;
      resume = done;
      const tick: FrameRequestCallback = now => {
        elapsed += last === undefined ? 0 : Math.max(0, Math.min(50, now - last));
        last = now;
        const ratio = Math.min(1, elapsed / duration);
        if (ratio >= 1) { finish(); return; }
        const weight = smoothMix(ratio);
        try {
          ctx.clearRect(0, 0, front.width, front.height);
          ctx.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = 1 - weight;
          ctx.drawImage(frozen, 0, 0);
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = weight;
          paint(ctx, front.width);
        } catch { finish(); return; }
        finally { ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; }
        frame = window.requestAnimationFrame(tick);
      };
      frame = window.requestAnimationFrame(tick);
    },
    reduce() { if (resume) finish(); },
    clear,
  };
}
