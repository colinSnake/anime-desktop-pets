import catalog from './clip-catalog.json';
import { moveFacing, movements, releasePoses, releaseRanges, travelRanges, type Facing, type ReleaseAction, type ReleasePose } from './locomotion';

type MediaFile = keyof typeof catalog;
export const mediaFiles = Object.keys(catalog) as MediaFile[];
const fullMovements = movements.map(move => `full-${move}` as const);
const onceIdles = ['once-idle', 'once-idle2'] as const;
export const clips = [...mediaFiles, ...releasePoses, ...fullMovements, ...onceIdles] as const;
export type Clip = typeof clips[number];
export function isClip(value: unknown): value is Clip { return clips.some(clip => clip === value); }
export function isGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
export const isFullMovement = (clip: Clip): clip is typeof fullMovements[number] => fullMovements.some(move => move === clip);
export const isMediaTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 60_000;
export const loops = (clip: Clip) => isReleasePose(clip) ||
  (!isFullMovement(clip) && clip !== 'once-idle' && clip !== 'once-idle2' && (isMovement(clip) || catalog[clip].loop));
const isMovement = (clip: string): clip is typeof movements[number] => movements.some(move => move === clip);
const isReleasePose = (clip: Clip): clip is ReleasePose => releasePoses.some(pose => pose === clip);
export function clipSource(clip: Clip): { file: typeof mediaFiles[number]; range?: readonly [number, number]; facing?: Facing } {
  if (clip === 'once-idle' || clip === 'once-idle2') return { file: clip === 'once-idle' ? 'idle' : 'idle2' };
  if (isReleasePose(clip)) {
    const file = clip.slice(8) as ReleaseAction;
    return { file, range: releaseRanges[file], facing: moveFacing(file) };
  }
  if (isFullMovement(clip)) {
    const file = clip.slice(5) as typeof movements[number];
    return { file, facing: moveFacing(file) };
  }
  return isMovement(clip) ? { file: clip, range: travelRanges[clip], facing: moveFacing(clip) } : { file: clip };
}
export const videoIPC = {
  action: 'pet-video:action', resetDrag: 'pet-video:reset-drag', hit: 'pet-video:hit', gesture: 'pet-video:gesture', frame: 'pet-video:frame', travelFrame: 'pet-video:travel-frame',
  contextMenu: 'pet-video:context-menu', menuState: 'pet-video:menu-state',
  caption: 'pet-video:caption', captionShown: 'pet-video:caption-shown',
  quotaOpen: 'pet-video:quota-open', quotaRefresh: 'pet-video:quota-refresh',
  quotaClose: 'pet-video:quota-close', quotaState: 'pet-video:quota-state', face: 'pet-video:face', reducedMotion: 'pet-video:reduced-motion',
} as const;

type Request = { clip: Clip; generation: number };
interface VideoPort {
  prepare(slot: number, clip: Clip, signal: AbortSignal): Promise<void>;
  reveal(slot: number, clip: Clip, generation: number): void;
  fail(clip: Clip, generation: number): void;
}
export function createClipSwitcher(port: VideoPort) {
  let active: (Request & { slot: number; finished: boolean }) | undefined;
  let loading: (Request & { abort: AbortController }) | undefined;
  let latest = 0;
  let closed = false;
  return {
    async show(clip: Clip, generation: number) {
      if (closed || generation <= latest) return;
      latest = generation;
      if (loading?.clip === clip) { loading.generation = generation; return; }
      loading?.abort.abort();
      loading = undefined;
      if (active?.clip === clip && !active.finished) {
        active.generation = generation;
        port.reveal(active.slot, clip, generation);
        return;
      }
      const slot = active?.slot === 0 ? 1 : 0;
      const ticket = { abort: new AbortController(), clip, generation };
      loading = ticket;
      try { await port.prepare(slot, clip, ticket.abort.signal); }
      catch {
        if (ticket === loading) {
          loading = undefined;
          port.fail(clip, ticket.generation);
        }
        return;
      }
      if (ticket !== loading) return;
      loading = undefined;
      active = { slot, clip, generation: ticket.generation, finished: false };
      port.reveal(slot, clip, ticket.generation);
    },
    onEnded(slot: number): Request | undefined {
      if (loading || active?.slot !== slot || active.finished || loops(active.clip)) return;
      active.finished = true;
      return { clip: active.clip, generation: active.generation };
    },
    close() {
      closed = true;
      loading?.abort.abort();
      loading = undefined;
      active = undefined;
    },
  };
}
