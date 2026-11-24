import type companionMedia from '../../../../config/local-companion-media.json';

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

// Validated private source files. Standstill/setup and authored endings stay in the full previews.
export const companionDaily = ['companion-stretch', 'companion-4f74c11cf2c1', 'companion-24eb1c6816e4'] as const satisfies readonly (keyof typeof companionMedia.actions)[];
const walk = { file: 'companion-26bf18c72287', range: [2000, 5000], distance: 100, height: 0, label: '螃蟹走路' } as const;
const run = { file: 'companion-77bd0761591e', range: [750, 2750], distance: 100, height: 0, label: '侧身急躁跑' } as const;
const float = { file: 'companion-307947b984ef', range: [1000, 4500], distance: 86, height: 40, label: '原地漂浮踏步' } as const;
export const companionTravel = {
  move01left: walk, move01right: walk, move02left: run, move02: run, move03left: float, move03right: float,
} satisfies Record<Movement, { file: keyof typeof companionMedia.actions; range: readonly [number, number]; distance: number; height: number; label: string }>;
