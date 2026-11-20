import type { BrowserWindow } from 'electron';
import { planWorkspaceReveal, validWorkspaceBounds, type WorkspaceBounds } from './workspace-placement.ts';

type PlacementWindow = Pick<BrowserWindow, 'isDestroyed' | 'isVisible' | 'isMinimized' | 'isMaximized' | 'isFullScreen'
  | 'getNormalBounds' | 'getMinimumSize' | 'setMinimumSize' | 'setBounds'>;
type WorkAreas = { primary: WorkspaceBounds; areas: readonly WorkspaceBounds[] };
export type PlacementTrigger = 'display' | 'reopen';

export function adjustWorkspacePlacement(window: PlacementWindow, trigger: PlacementTrigger, readAreas: () => WorkAreas) {
  if (window.isDestroyed() || window.isMinimized() || window.isMaximized() || window.isFullScreen()
    || (trigger === 'display' && !window.isVisible())) return;
  const before = window.getNormalBounds();
  if (!validWorkspaceBounds(before)) return;
  const { primary, areas } = readAreas();
  if (!validWorkspaceBounds(primary)) return;
  const { bounds, minimum } = planWorkspaceReveal(before, primary, areas.filter(validWorkspaceBounds));
  if (!bounds && trigger === 'display') return;
  const [width, height] = window.getMinimumSize();
  if (width !== minimum.width || height !== minimum.height) window.setMinimumSize(minimum.width, minimum.height);
  else if (!bounds) return;
  if (bounds) window.setBounds(bounds, false);
  return { before, after: window.getNormalBounds(), relocated: !!bounds };
}

type Subscribe = (listener: () => void) => () => void;
type Schedule = (delay: number, callback: () => void) => () => void;
const scheduleTimer: Schedule = (delay, callback) => {
  const timer = setTimeout(callback, delay);
  timer.unref();
  return () => clearTimeout(timer);
};

/** Combine notification bursts and read the window and displays only when the check runs. */
export function watchWorkspaceDisplayChanges(subscribe: Subscribe, check: () => void, schedule: Schedule = scheduleTimer): () => void {
  let disposed = false;
  let pending: (() => void) | undefined;
  const unsubscribe = subscribe(() => {
    if (disposed || pending) return;
    pending = schedule(120, () => {
      if (disposed) return;
      pending = undefined;
      check();
    });
  });
  return () => {
    if (disposed) return;
    disposed = true;
    pending?.();
    pending = undefined;
    unsubscribe();
  };
}
