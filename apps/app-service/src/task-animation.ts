/** Fixed service-to-player projection. Never part of a public transport or a saved configuration. */
export type TaskAnimation = {
  state: 'working' | 'idle' | 'unknown' | 'disabled';
  startSerial: number;
  expiresAt: number;
};

export const TASK_ANIMATION_MS = 6000;
export const taskAnimationOff: TaskAnimation = Object.freeze({ state: 'disabled', startSerial: 0, expiresAt: 0 });
