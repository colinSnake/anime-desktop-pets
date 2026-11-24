import { clipSource, isTravelClip, loops, type Clip } from './playback';

/** Keep the last good layer while the bounded replacement gears up at its media offset. */
export function prepareFirstFrame(video: HTMLVideoElement, clip: Clip, signal: AbortSignal,
  ready: (mediaMs: number) => void = () => {}, continueSource = false): Promise<void> {
  const source = clipSource(clip);
  return new Promise<void>((resolve, reject) => {
    let frame: number | undefined;
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (frame !== undefined) video.cancelVideoFrameCallback(frame);
      signal.removeEventListener('abort', failed);
      video.removeEventListener('error', failed);
      video.removeEventListener('loadedmetadata', seek);
      if (ready) resolve();
      else {
        video.pause();
        video.removeAttribute('src');
        video.load();
        reject(new Error('视频首帧不可用'));
      }
    };
    const failed = () => finish(false);
    const timeout = setTimeout(failed, 5000);
    const watch = () => {
      frame = video.requestVideoFrameCallback((_now, metadata) => {
        if (settled) return;
        // Seeking may also report the nearest earlier frame. Never present
        // the standstill introduction or the original file's tired tail.
        if (source.range && (video.seeking || metadata.mediaTime * 1000 + .5 < source.range[0])) {
          watch();
          return;
        }
        if (source.range && metadata.mediaTime * 1000 >= source.range[1]) { failed(); return; }
        video.pause();
        ready(metadata.mediaTime * 1000);
        finish(true);
      });
    };
    const seek = () => {
      if (!source.range) return;
      const [start, stop] = source.range;
      if (!Number.isFinite(video.duration) || stop > video.duration * 1000 + .5) { failed(); return; }
      try {
        video.currentTime = start / 1000;
        watch();
        void video.play().catch(failed);
      } catch { failed(); }
    };
    if (signal.aborted) { failed(); return; }
    signal.addEventListener('abort', failed, { once: true });
    video.addEventListener('error', failed, { once: true });
    video.muted = true;
    video.loop = loops(clip) && !source.range;
    if (continueSource) { watch(); void video.play().catch(failed); return; }
    if (source.range) video.addEventListener('loadedmetadata', seek, { once: true });
    video.src = `./${source.file}.webm`;
    video.load();
    if (!source.range) { watch(); void video.play().catch(failed); }
  });
}

type Frames = {
  frame(mediaMs: number): void;
  seamStart(validTail: boolean): void;
  seamEnd(): void;
  ended?(): void;
};

/** Observe media time (not wall time); never treat a seek callback as a decoded head. */
export function keepSegment(video: HTMLVideoElement, clip: Clip, fail: () => void, events?: Frames): () => void {
  const { range, file } = clipSource(clip);
  if (!range && !events) return () => {};
  const frameMs = 1000 / (file.startsWith('move03') ? 30 : 24); // pinned source frame rates
  let callback = 0;
  let disposed = false;
  let seam: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { disposed = true; clearTimeout(seam); video.cancelVideoFrameCallback(callback); };
  const failed = () => { if (!disposed) { stop(); fail(); } };
  const watch = () => {
    callback = video.requestVideoFrameCallback((_now, metadata) => {
      if (disposed) return;
      const ms = metadata.mediaTime * 1000;
      if (!range) events?.frame(ms);
      else if (!video.seeking) {
        const [start, end] = range;
        const legal = ms + .5 >= start && ms + .5 < end;
        if (seam !== undefined) {
          if (legal && ms <= start + 3 * frameMs) {
            clearTimeout(seam);
            seam = undefined;
            events?.frame(ms);
            events?.seamEnd();
          }
        } else {
          const terminal = ms + .5 >= end - frameMs;
          if (legal) events?.frame(terminal && isTravelClip(clip) ? end : ms);
          // Request the cut from the last legal frame rather than presenting the authored tail.
          if (terminal) {
            if (!loops(clip)) {
              video.pause();
              events?.ended?.();
              stop();
              return;
            }
            try {
              events?.seamStart(legal);
              seam = setTimeout(failed, 5000);
              video.currentTime = start / 1000;
            } catch { failed(); return; }
          }
        }
      }
      if (!disposed) watch();
    });
  };
  watch();
  return stop;
}
