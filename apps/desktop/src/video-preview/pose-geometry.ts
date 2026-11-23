import { clipSource, type Clip } from './playback';
import catalog from './clip-catalog.json';

export type PoseRect = { x: number; y: number; width: number; height?: number; mirrored: boolean };

/** Keep the saved position/physics in nominal canvas coordinates (Qt's round ties to even). */
export function overscan(size: number): number {
  const quarters = size / 4;
  return size % 8 === 2 ? Math.floor(quarters) : Math.round(quarters);
}
export const paddedSize = (size: number) => size + 2 * overscan(size);
export function nominalSize(padded: number): number {
  const guess = Math.round(padded / 1.5);
  return [guess, guess + 1, guess - 1].find(size => paddedSize(size) === padded) ?? guess;
}

/** Authored bottom anchor and pinned left-flight source-time ramp from dragon_playback.py. */
export function poseRect(clip: Clip, size: number, mediaMs: number, mirrored: boolean): PoseRect {
  const { file } = clipSource(clip);
  const { scale, offset } = catalog[file as keyof typeof catalog];
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  const weight = file === 'move03left' ? Math.min(clamp((mediaMs - 2500) / 625), clamp((6700 - mediaMs) / 1000)) : 0;
  const width = size * (scale + (1.30 - scale) * weight * weight * (3 - 2 * weight));
  const edge = paddedSize(size);
  const x = (edge - width) / 2 + size * offset[0]!;
  return {
    x: file === 'move03left' && mirrored ? edge - x - width : x,
    y: overscan(size) + size - width + size * offset[1]!,
    width, mirrored,
  };
}

/** The companion's 640×360 source has a centered silhouette and a bottom anchor at 330px. */
export function companionRect(size: number): PoseRect {
  const height = size * 1.2;
  const width = height * 640 / 360;
  return { x: (paddedSize(size) - width) / 2, y: overscan(size) + size - height * 330 / 360,
    width, height, mirrored: false };
}
