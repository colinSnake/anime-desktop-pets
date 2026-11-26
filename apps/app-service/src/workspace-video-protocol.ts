import { packageReference, petId, preferences, revision, shape, type BehaviorPreferences, type PackageReference, type PetPreferences } from '../../../packages/contracts/src/pets.ts';

import { isCue } from './speech/cue.ts';
import type { TaskAnimation } from './task-animation.ts';

type Header = { version: 1; seq: number; id: string };
export type VideoDisplay = { size: number; hideInFullscreen: boolean };
export type VideoSpeechState = 'held' | 'drained' | 'released';
export type VideoCaptionSpeech = { cue: number; state: VideoSpeechState };
export type VideoControl = { op: 'display'; value: VideoDisplay } | { op: 'behavior'; value: BehaviorPreferences } | { op: 'visibility'; value: boolean } | { op: 'task'; value: TaskAnimation } | { op: 'caption-speech'; value: VideoCaptionSpeech };
export type VideoCommand = Header & { type: 'workspace-video-command' } & (
  { op: 'start'; package: PackageReference; preferences: PetPreferences } | { op: 'stop' } | (VideoControl & { epoch: number })
);
export type VideoResult = 'running' | 'stopped' | 'failed' | 'applied';
export type VideoReply = Header & { type: 'workspace-video-result' | 'workspace-video-ended'; result: VideoResult };
export type VideoPosition = { x: number; y: number };
export type VideoDrop = Header & VideoPosition & { type: 'workspace-video-drop' };
export type VideoCue = Header & { type: 'workspace-video-cue'; cue: number; text: string | null };
export const videoSizePresets = [128, 192, 256, 320, 384] as const;
export type VideoMenuIntent = { kind: 'hide' } | { kind: 'size'; value: typeof videoSizePresets[number] } |
  { kind: 'hideInFullscreen' | 'scheduledActivity' | 'movement'; value: boolean };
export type VideoMenu = Header & { type: 'workspace-video-menu'; intent: VideoMenuIntent };
export type VideoMessage = VideoReply | VideoDrop | VideoCue | VideoMenu;

export function videoMenu(value: unknown): value is VideoMenu {
  if (!shape(value, ['type', 'version', 'id', 'seq', 'intent']) || !header(value) || value.type !== 'workspace-video-menu') return false;
  const intent = value.intent;
  if (!shape(intent, ['kind', 'value'])) return false;
  if (intent.kind === 'hide') return !Object.hasOwn(intent, 'value');
  if (intent.kind === 'size') return videoSizePresets.some(size => size === intent.value);
  return ['hideInFullscreen', 'scheduledActivity', 'movement'].some(kind => kind === intent.kind) && typeof intent.value === 'boolean';
}
export function videoPosition(value: unknown): value is VideoPosition {
  return shape(value, ['x', 'y']) && coordinate(value.x) && coordinate(value.y);
}
const coordinate = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000;

const header = (v: Record<string, unknown>) => v.version === 1 && revision(v.seq) && v.seq > 0 && petId(v.id);

export function videoCommand(value: unknown): value is VideoCommand {
  if (shape(value, ['type', 'version', 'id', 'seq', 'op', 'epoch', 'value']) && header(value) &&
      value.type === 'workspace-video-command' && revision(value.epoch) && value.epoch > 0 && value.epoch < Number(value.seq)) {
    if (value.op === 'visibility') return typeof value.value === 'boolean';
    if (value.op === 'behavior') return shape(value.value, ['scheduledActivity', 'movement']) &&
      typeof value.value.scheduledActivity === 'boolean' && typeof value.value.movement === 'boolean';
    if (value.op === 'task') return videoTask(value.value);
    if (value.op === 'caption-speech') return shape(value.value, ['cue', 'state']) && revision(value.value.cue) && value.value.cue > 0 &&
      (value.value.state === 'held' || value.value.state === 'drained' || value.value.state === 'released');
    return value.op === 'display' && videoDisplay(value.value);
  }
  return shape(value, ['type', 'version', 'id', 'seq', 'op', 'preferences', 'package']) && header(value) &&
    value.type === 'workspace-video-command' && (value.op === 'start' ? packageReference(value.package) && preferences(value.preferences)
      : value.op === 'stop' && !Object.hasOwn(value, 'preferences') && !Object.hasOwn(value, 'package'));
}
function videoTask(value: unknown): value is TaskAnimation {
  if (!shape(value, ['state', 'startSerial', 'expiresAt']) || !revision(value.startSerial) || !revision(value.expiresAt)) return false;
  if (value.state === 'working') return value.expiresAt > 0;
  return (value.state === 'idle' || value.state === 'unknown' || value.state === 'disabled') && value.startSerial === 0 && value.expiresAt === 0;
}
export function videoDisplay(value: unknown): value is VideoDisplay {
  return shape(value, ['size', 'hideInFullscreen']) && typeof value.size === 'number' && Number.isInteger(value.size) &&
    value.size >= 128 && value.size <= 384 && typeof value.hideInFullscreen === 'boolean';
}

export function videoReply(value: unknown): value is VideoReply {
  return shape(value, ['type', 'version', 'id', 'seq', 'result']) && header(value) &&
    (value.type === 'workspace-video-result' && (value.result === 'running' || value.result === 'applied') ||
     (value.type === 'workspace-video-result' || value.type === 'workspace-video-ended') && (value.result === 'stopped' || value.result === 'failed'));
}

export function videoDrop(value: unknown): value is VideoDrop {
  return shape(value, ['type', 'version', 'id', 'seq', 'x', 'y']) && header(value) && value.type === 'workspace-video-drop' &&
    coordinate(value.x) && coordinate(value.y);
}

export function videoCue(value: unknown): value is VideoCue {
  return shape(value, ['type', 'version', 'id', 'seq', 'cue', 'text']) && header(value) && value.type === 'workspace-video-cue' &&
    revision(value.cue) && value.cue > 0 && (value.text === null || isCue(value.text));
}
