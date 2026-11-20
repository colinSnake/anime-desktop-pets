// These intervals are from the pinned v0.5.1 manifest, and the release ranges
// select the same original frames as the prepared Qt release-loop catalog.
// Media time is in ms; intervals are [start, stop). No new media is persisted.
export const movements = ['move02', 'move02left', 'move01left', 'move01right', 'move03left', 'move03right'] as const;
export type Movement = typeof movements[number];
export type Facing = 'left' | 'right';
export const releases = ['move02', 'move02left', 'move03left', 'move03right'] as const;
export type ReleaseAction = typeof releases[number];
export type ReleasePose = `release-${ReleaseAction}`;
export const releasePoses = releases.map(action => `release-${action}` as const);
export const moveFacing = (move: Movement): Facing => move.endsWith('left') ? 'left' : 'right';
export const travelRanges: Record<Movement, readonly [number, number]> = {
  move02: [4750, 7500], move02left: [1917, 5250], move01left: [1000, 3250],
  move01right: [750, 3250], move03left: [3125, 7750], move03right: [3300, 7750],
};
export const releaseRanges: Record<ReleaseAction, readonly [number, number]> = {
  move02: [125 * 1000 / 24, 155 * 1000 / 24], move02left: [62 * 1000 / 24, 113 * 1000 / 24],
  move03left: [113 * 1000 / 30, 158 * 1000 / 30], move03right: [119 * 1000 / 30, 187 * 1000 / 30],
};
