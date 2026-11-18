import { scheduleStartupTimer } from './startup-playback.ts';

export type StartupBounds = { x: number; y: number; width: number; height: number };
type Display = { bounds: StartupBounds; workArea: StartupBounds };
type Ports = {
  read(signal: AbortSignal): Promise<StartupBounds | undefined>;
  displays(): readonly Display[];
  apply(bounds: StartupBounds): void;
  schedule?: typeof scheduleStartupTimer;
};
const LIMIT_MS = 8000;
const MAX_SAMPLES = 12;
const right = ({ x, width }: StartupBounds) => x + width;
const bottom = ({ y, height }: StartupBounds) => y + height;

export function centeredStartupBounds(area: StartupBounds, scale = 1): StartupBounds {
  const width = Math.max(1, Math.floor(Math.min(1280, area.width * scale, area.height * scale * 16 / 9)));
  const height = Math.max(1, Math.floor(width * 9 / 16));
  return { x: area.x + Math.floor((area.width - width) / 2), y: area.y + Math.floor((area.height - height) / 2), width, height };
}

export function alignedStartupBounds(window: StartupBounds, displays: readonly Display[]): StartupBounds | undefined {
  const matches = displays.filter(({ workArea }) => window.x >= workArea.x && window.y >= workArea.y
    && right(window) <= right(workArea) && bottom(window) <= bottom(workArea));
  const display = matches[0];
  if (!display || matches.length !== 1) return;
  const full = display.bounds;
  // Work area and display bounds can coincide (e.g. auto-hide). Don't cover a full-screen surface.
  if (window.x <= full.x + 2 && window.y <= full.y + 2 && right(window) >= right(full) - 2 && bottom(window) >= bottom(full) - 2) return;
  return centeredStartupBounds(window);
}

const equal = (a: StartupBounds, b: StartupBounds) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** Align at most once; guard both bounds and display mapping against a transient launch frame. */
export function startStartupAlignment(ports: Ports): () => void {
  const schedule = ports.schedule ?? scheduleStartupTimer;
  const controller = new AbortController();
  const { signal } = controller;
  const deadline = performance.now() + LIMIT_MS;
  let attempts = 0;
  let previous: { window: StartupBounds; placement: StartupBounds } | undefined;
  const close = () => {
    if (signal.aborted) return;
    controller.abort();
    cancelDeadline();
    cancelSample();
  };
  const sample = async () => {
    if (signal.aborted || performance.now() >= deadline) { close(); return; }
    attempts++;
    let current: typeof previous;
    try {
      const window = await ports.read(signal);
      if (signal.aborted || performance.now() >= deadline) { close(); return; }
      const placement = window && alignedStartupBounds(window, ports.displays());
      if (window && placement) current = { window, placement };
    } catch { /* Missing display or window is an invalid sample. */ }
    if (signal.aborted || performance.now() >= deadline) { close(); return; }
    if (previous && current && equal(previous.window, current.window) && equal(previous.placement, current.placement)) {
      close();
      try { ports.apply(current.placement); } catch { /* A destroyed window needs no alignment. */ }
      return;
    }
    previous = current;
    if (attempts === MAX_SAMPLES) close();
    else cancelSample = schedule(500, sample);
  };
  const cancelDeadline = schedule(LIMIT_MS, close);
  let cancelSample = schedule(0, sample);
  return close;
}
